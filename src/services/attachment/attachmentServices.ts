import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import type {
  AttachmentInsertType,
  AttachmentProcessedOutcome,
  AttachmentProcessedPayload,
  AttachmentType,
  AttachmentView,
} from "./types.js";
import { attachmentStore } from "./attachmentStore.js";
import {
  AttachmentRejectionReason,
  isAttachmentContentType,
  processAttachment,
} from "./processor.js";
import { finalStorageKey, incomingKey } from "./s3Layout.js";
import AppError from "../../utils/appError.js";

const live = isNull(attachments.deletedAt);

export const toAttachmentView = (row: AttachmentType): AttachmentView => ({
  id: row.id,
  requestId: row.requestId,
  fileName: row.fileName,
  contentType: row.contentType,
  size: row.size,
  status: row.status,
  rejectionReason: row.rejectionReason,
  uploadedByUserId: row.uploadedByUserId,
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
  deletedByUserId: row.deletedByUserId,
});

export const getAttachmentById = async (
  attachmentId: string,
  tx?: DbTransaction
): Promise<AttachmentType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), live));
  return row;
};

/** Deleted rows included: the detail lists them so the timeline can explain a file that went away. */
export const listAttachmentsForRequest = async (
  requestId: string,
  tx?: DbTransaction
): Promise<AttachmentView[]> => {
  const rows = await (tx ?? db)
    .select()
    .from(attachments)
    .where(eq(attachments.requestId, requestId))
    .orderBy(attachments.createdAt);
  return rows.map(toAttachmentView);
};

/**
 * Serialises attachment creation per Request for the rest of the transaction,
 * so two parallel creates cannot both read four rows and both insert a fifth.
 */
export const lockRequestForAttachments = async (
  requestId: string,
  tx: DbTransaction
): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${requestId}))`);
};

/** Uploading and ready rows both hold a slot; a rejected one frees it. */
export const holdsAttachmentSlot = (status: AttachmentStatus): boolean =>
  status === AttachmentStatus.Uploading || status === AttachmentStatus.Ready;

export const countAttachmentSlotsUsed = async (
  requestId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ used: count() })
    .from(attachments)
    .where(
      and(
        eq(attachments.requestId, requestId),
        live,
        inArray(attachments.status, Object.values(AttachmentStatus).filter(holdsAttachmentSlot))
      )
    );
  return row?.used ?? 0;
};

export const createAttachment = async (
  data: AttachmentInsertType,
  tx?: DbTransaction
): Promise<AttachmentType> => {
  const [row] = await (tx ?? db).insert(attachments).values(data).returning();
  if (!row) {
    throw new AppError({ message: "Failed to create attachment", logging: true, code: 500 });
  }
  return row;
};

/**
 * Locks the live row for the rest of the transaction, so a second delivery of
 * the same bytes, from the disk route or the Lambda, waits here, finds the row
 * settled, and stops.
 */
const lockLive = async (
  attachmentId: string,
  tx: DbTransaction
): Promise<AttachmentType | undefined> => {
  const [attachment] = await tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), live))
    .for("update");
  return attachment;
};

const lockUploading = async (
  attachmentId: string,
  tx: DbTransaction
): Promise<AttachmentType | undefined> => {
  const attachment = await lockLive(attachmentId, tx);
  return attachment?.status === AttachmentStatus.Uploading ? attachment : undefined;
};

/** The one ready-or-rejected transition; the local path and the Lambda callback both end here. */
const settleProcessed = async (
  attachment: AttachmentType,
  outcome: AttachmentProcessedOutcome,
  tx: DbTransaction
): Promise<AttachmentType | undefined> => {
  const patch =
    outcome.status === "READY"
      ? {
          status: AttachmentStatus.Ready,
          contentType: outcome.contentType,
          size: outcome.size,
          storageKey: finalStorageKey(attachment.storageKey, outcome.contentType),
        }
      : { status: AttachmentStatus.Rejected, rejectionReason: outcome.rejectionReason };
  const [row] = await tx
    .update(attachments)
    .set(patch)
    .where(eq(attachments.id, attachment.id))
    .returning();
  return row;
};

/**
 * What the S3 event does in production (docs/adr/0003), run in-process by the
 * disk store: check the bytes, rewrite images, store the result under the
 * final key and settle the row. Undefined when the row is not waiting for bytes.
 */
export const completeUpload = async (
  attachmentId: string,
  bytes: Buffer
): Promise<AttachmentType | undefined> =>
  db.transaction(async (tx) => {
    const attachment = await lockUploading(attachmentId, tx);
    if (!attachment) return undefined;

    const rejected = (rejectionReason: AttachmentRejectionReason) =>
      settleProcessed(attachment, { status: "REJECTED", rejectionReason }, tx);

    if (!isAttachmentContentType(attachment.contentType)) {
      return rejected(AttachmentRejectionReason.TypeMismatch);
    }
    const processed = await processAttachment(bytes, attachment.contentType);
    if (!processed.ok) return rejected(processed.reason);

    await attachmentStore.putObject(
      finalStorageKey(attachment.storageKey, processed.contentType),
      processed.bytes
    );
    return settleProcessed(
      attachment,
      { status: "READY", contentType: processed.contentType, size: processed.bytes.length },
      tx
    );
  });

/**
 * The Lambda's report, applied exactly as the local path applies its own.
 * The bytes are already under the final key; only the row moves. Undefined
 * when the row is missing or deleted; `changed: false` with the row as it
 * stands when an earlier delivery already settled it.
 */
export const markAttachmentProcessed = async (
  payload: AttachmentProcessedPayload
): Promise<{ attachment: AttachmentType; changed: boolean } | undefined> =>
  db.transaction(async (tx) => {
    const attachment = await lockLive(payload.attachmentId, tx);
    if (!attachment) return undefined;
    if (attachment.status !== AttachmentStatus.Uploading) return { attachment, changed: false };
    const settled = await settleProcessed(attachment, payload, tx);
    return settled && { attachment: settled, changed: true };
  });

/**
 * Whatever the row has in the store: the checked object under its key, and,
 * while it is still `UPLOADING`, whatever the browser may have posted to the
 * incoming prefix. Both deletes are no-ops for a key that holds nothing.
 */
export const deleteStoredBytes = async (
  attachment: Pick<AttachmentType, "id" | "storageKey" | "status">
): Promise<void> => {
  await attachmentStore.deleteObject(attachment.storageKey);
  if (attachment.status === AttachmentStatus.Uploading) {
    await attachmentStore.deleteObject(incomingKey(attachment.id));
  }
};

/**
 * Soft-deletes the row, then removes the bytes. The row is stamped first so an
 * upload settling at the same moment cannot store bytes after this call has
 * removed them: it waits on the row, finds it no longer live, and stops.
 * Undefined when the row was already deleted.
 */
export const deleteAttachment = async (
  attachmentId: string,
  deletedByUserId: string
): Promise<AttachmentType | undefined> => {
  const [row] = await db
    .update(attachments)
    .set({ deletedAt: new Date(), deletedByUserId })
    .where(and(eq(attachments.id, attachmentId), live))
    .returning();
  if (!row) return undefined;
  await deleteStoredBytes(row);
  return row;
};

/** The original name, with the extension corrected for images the processor rewrote to JPEG. */
export const downloadFileName = (attachment: Pick<AttachmentType, "fileName" | "contentType">) => {
  if (attachment.contentType !== "image/jpeg") return attachment.fileName;
  const base = attachment.fileName.replace(/\.(png|webp|jpe?g|heic|heif)$/i, "");
  return `${base}.jpg`;
};
