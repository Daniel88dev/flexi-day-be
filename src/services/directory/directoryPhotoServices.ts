import { and, eq, inArray, ne } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryPhotos, directoryPhotoStatus } from "../../db/schema/directory-photo-schema.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import {
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import AppError, { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { logger } from "../../middleware/logger.js";
import { isProfilePhotoContentType, processProfilePhoto } from "../attachment/processor.js";
import { MAX_ATTACHMENT_BYTES, type UploadTarget } from "../attachment/types.js";
import { assertDirectoryWritable } from "../billing/guards.js";
import {
  organizationDataStore,
  type OrganizationDataStore,
} from "../organizationData/organizationDataStore.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type { PhotoProcessedOutcome } from "./types.js";

export const MAX_PROFILE_PHOTO_BYTES = MAX_ATTACHMENT_BYTES;

export const PHOTO_GONE_REASON = "PHOTO_GONE";

/** Everything stored for one organization's photos, for deleting the organization. */
export const organizationPhotosPrefix = (organizationId: string) => `photos/${organizationId}/`;

/** Every photo an Employment ever had, for Erase and retention purges. */
export const employmentPhotosPrefix = (organizationId: string, employmentId: string) =>
  `${organizationPhotosPrefix(organizationId)}${employmentId}/`;

/** One upload's folder: its `small.jpg` and `full.jpg`. */
export const photoPrefix = (photo: { organizationId: string; employmentId: string; id: string }) =>
  `${employmentPhotosPrefix(photo.organizationId, photo.employmentId)}${photo.id}/`;

export const photoKeys = (prefix: string) => ({
  small: `${prefix}small.jpg`,
  full: `${prefix}full.jpg`,
});

export type PhotoUploadStatus = {
  id: string;
  status: directoryPhotoStatus;
  rejectionReason: string | null;
};

export const requireStore = (context: object): OrganizationDataStore => {
  if (!organizationDataStore) {
    throw new AppError({
      code: 503,
      message: "Profile photos are not available yet",
      logging: true,
      context,
    });
  }
  return organizationDataStore;
};

/** The record, locked, and the viewer's Photo level on it; 404 out of reach. */
const lockRecordFor = async (viewer: DirectoryViewer, employmentId: string, tx: DbTransaction) => {
  const context = {
    organizationId: viewer.organizationId,
    employmentId,
    viewerUserId: viewer.standing.userId,
  };
  const [record] = await tx
    .select({ id: employments.id, userId: employments.userId, endedAt: employments.endedAt })
    .from(employments)
    .where(
      and(eq(employments.organizationId, viewer.organizationId), eq(employments.id, employmentId))
    )
    .for("update");
  const access =
    record && viewer.accessTo({ userId: record.userId, ended: record.endedAt !== null });
  if (!record || !access?.inReach) {
    throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);
  }
  return { record, access, context };
};

const requirePhotoWrite = (
  access: Awaited<ReturnType<typeof lockRecordFor>>["access"],
  context: object
) => {
  if (access.sections[R.Photo] !== V.Write) {
    throw refuse(403, "SECTION_NOT_WRITABLE", "You can't change this Profile photo", {
      ...context,
      row: R.Photo,
    });
  }
};

/**
 * Starts an upload: a row in `UPLOADING` and where the browser sends the
 * bytes. Setting a photo needs the directory plan. Any earlier upload of
 * this Employment that never settled is dropped, so its late report finds
 * nothing and the Lambda removes what it wrote.
 */
export const requestPhotoUpload = async (
  viewer: DirectoryViewer,
  employmentId: string,
  input: { contentType: string; size: number },
  tx: DbTransaction
): Promise<{ photo: PhotoUploadStatus; upload: UploadTarget }> => {
  const { access, context } = await lockRecordFor(viewer, employmentId, tx);
  requirePhotoWrite(access, context);
  await assertDirectoryWritable(viewer.organizationId, tx);
  if (!isProfilePhotoContentType(input.contentType)) {
    throw new AppError({
      code: 422,
      message: "A Profile photo is a PNG, JPEG, WebP or HEIC image",
      logging: true,
      context,
      publicContext: { reason: "UNSUPPORTED_TYPE" },
    });
  }
  if (input.size > MAX_PROFILE_PHOTO_BYTES) {
    throw new AppError({
      code: 422,
      message: "A Profile photo is at most 10 MB",
      logging: true,
      context,
      publicContext: { reason: "FILE_TOO_LARGE", limit: MAX_PROFILE_PHOTO_BYTES },
    });
  }
  const store = requireStore(context);

  await tx
    .delete(directoryPhotos)
    .where(
      and(
        eq(directoryPhotos.employmentId, employmentId),
        ne(directoryPhotos.status, directoryPhotoStatus.Ready)
      )
    );
  const [photo] = await tx
    .insert(directoryPhotos)
    .values({
      id: generateRandomUUID(),
      organizationId: viewer.organizationId,
      employmentId,
      contentType: input.contentType,
      size: input.size,
      uploadedByUserId: viewer.standing.userId,
      audience: access.grantedBy[R.Photo]!,
    })
    .returning();
  const upload = await store.createPhotoUploadTarget({
    photoId: photo!.id,
    contentType: input.contentType,
    size: input.size,
    storageKey: photoPrefix(photo!),
  });
  return { photo: toStatus(photo!), upload };
};

const toStatus = (row: typeof directoryPhotos.$inferSelect): PhotoUploadStatus => ({
  id: row.id,
  status: row.status,
  rejectionReason: row.rejectionReason,
});

/** How an upload stands, for the writer waiting on it. */
export const getPhotoUploadStatus = async (
  viewer: DirectoryViewer,
  employmentId: string,
  photoId: string
): Promise<PhotoUploadStatus> =>
  db.transaction(async (tx) => {
    const { access, context } = await lockRecordFor(viewer, employmentId, tx);
    requirePhotoWrite(access, context);
    const [row] = await tx
      .select()
      .from(directoryPhotos)
      .where(and(eq(directoryPhotos.id, photoId), eq(directoryPhotos.employmentId, employmentId)));
    if (!row) throw refuse(404, "PHOTO_NOT_FOUND", "Photo not found", { ...context, photoId });
    return toStatus(row);
  });

/** Deletes stored photo folders after the commit; a store failure is logged, the change stands. */
export const removePhotoObjects = async (prefixes: string[]): Promise<void> => {
  for (const prefix of prefixes) {
    try {
      await organizationDataStore?.deletePrefix(prefix);
    } catch (error) {
      logger.error("directory_photo.delete_failed", { prefix, error });
    }
  }
};

/**
 * Removes the Profile photo and any upload in flight. Never plan-gated.
 * Returns the folders to delete after the commit.
 */
export const removeProfilePhoto = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx: DbTransaction
): Promise<string[]> => {
  const { access, context } = await lockRecordFor(viewer, employmentId, tx);
  requirePhotoWrite(access, context);
  const removed = await tx
    .delete(directoryPhotos)
    .where(eq(directoryPhotos.employmentId, employmentId))
    .returning();
  if (removed.some((row) => row.status === directoryPhotoStatus.Ready)) {
    await tx.insert(directoryProfileHistory).values({
      id: generateRandomUUID(),
      organizationId: viewer.organizationId,
      employmentId,
      actorUserId: viewer.standing.userId,
      section: R.Photo,
      fields: ["photo"],
      audience: access.grantedBy[R.Photo]!,
    });
  }
  return removed.map(photoPrefix);
};

export type SettleResult =
  | { result: "applied"; photo: PhotoUploadStatus; replaced: string[] }
  | { result: "already"; photo: PhotoUploadStatus }
  | { result: "gone" };

/**
 * The one ready-or-rejected step, shared by the disk store and the Lambda's
 * report. The bytes are already stored. A `READY` photo replaces the
 * Employment's previous one and records a profile history row for whoever
 * started the upload; the replaced folders go after the commit.
 */
export const settlePhoto = async (
  photoId: string,
  outcome: PhotoProcessedOutcome,
  tx: DbTransaction
): Promise<SettleResult> => {
  const [photo] = await tx
    .select()
    .from(directoryPhotos)
    .where(eq(directoryPhotos.id, photoId))
    .for("update");
  if (!photo) return { result: "gone" };
  if (photo.status !== directoryPhotoStatus.Uploading) {
    return { result: "already", photo: toStatus(photo) };
  }
  if (outcome.status === "REJECTED") {
    const [rejected] = await tx
      .update(directoryPhotos)
      .set({ status: directoryPhotoStatus.Rejected, rejectionReason: outcome.rejectionReason })
      .where(eq(directoryPhotos.id, photoId))
      .returning();
    return { result: "applied", photo: toStatus(rejected!), replaced: [] };
  }

  const previous = await tx
    .delete(directoryPhotos)
    .where(
      and(
        eq(directoryPhotos.employmentId, photo.employmentId),
        eq(directoryPhotos.status, directoryPhotoStatus.Ready)
      )
    )
    .returning();
  const [ready] = await tx
    .update(directoryPhotos)
    .set({ status: directoryPhotoStatus.Ready, readyAt: new Date() })
    .where(eq(directoryPhotos.id, photoId))
    .returning();
  await tx.insert(directoryProfileHistory).values({
    id: generateRandomUUID(),
    organizationId: photo.organizationId,
    employmentId: photo.employmentId,
    actorUserId: photo.uploadedByUserId,
    section: R.Photo,
    fields: ["photo"],
    audience: photo.audience,
  });
  return { result: "applied", photo: toStatus(ready!), replaced: previous.map(photoPrefix) };
};

/**
 * What the S3 event does in production, run in-process by the disk store:
 * check and rewrite the bytes, store both sizes, settle the row. Undefined
 * when the row is not waiting for bytes.
 */
export const completeLocalPhotoUpload = async (
  photoId: string,
  bytes: Buffer
): Promise<PhotoUploadStatus | undefined> => {
  const [photo] = await db.select().from(directoryPhotos).where(eq(directoryPhotos.id, photoId));
  if (photo?.status !== directoryPhotoStatus.Uploading) return undefined;
  const store = requireStore({ photoId });

  const processed = await processProfilePhoto(bytes, photo.contentType);
  const prefix = photoPrefix(photo);
  if (processed.ok) {
    const keys = photoKeys(prefix);
    await store.putObject(keys.small, processed.small, "image/jpeg");
    await store.putObject(keys.full, processed.full, "image/jpeg");
  }
  const settled = await db.transaction((tx) =>
    settlePhoto(
      photoId,
      processed.ok
        ? { status: "READY" }
        : { status: "REJECTED", rejectionReason: processed.reason },
      tx
    )
  );
  if (settled.result !== "applied") {
    if (processed.ok) await removePhotoObjects([prefix]);
    return undefined;
  }
  await removePhotoObjects(settled.replaced);
  return settled.photo;
};

/** The current photo of each Employment that has one, by Employment id. */
export const readyPhotoIds = async (
  employmentIds: string[],
  tx?: DbTransaction
): Promise<Map<string, { id: string; organizationId: string; readyAt: Date | null }>> => {
  if (employmentIds.length === 0) return new Map();
  const rows = await (tx ?? db)
    .select({
      id: directoryPhotos.id,
      organizationId: directoryPhotos.organizationId,
      employmentId: directoryPhotos.employmentId,
      readyAt: directoryPhotos.readyAt,
    })
    .from(directoryPhotos)
    .where(
      and(
        inArray(directoryPhotos.employmentId, employmentIds),
        eq(directoryPhotos.status, directoryPhotoStatus.Ready)
      )
    );
  return new Map(rows.map((row) => [row.employmentId, row]));
};

export type ProfilePhotoView = { smallUrl: string; fullUrl: string };

/** Signed links to one photo's two sizes; undefined without a store. */
export const photoView = async (photo: {
  id: string;
  organizationId: string;
  employmentId: string;
}): Promise<ProfilePhotoView | undefined> => {
  if (!organizationDataStore) return undefined;
  const keys = photoKeys(photoPrefix(photo));
  return {
    smallUrl: await organizationDataStore.createImageUrl(keys.small),
    fullUrl: await organizationDataStore.createImageUrl(keys.full),
  };
};
