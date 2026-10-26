import { and, eq, inArray, or } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { attachments } from "../../db/schema/attachment-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { personExports, personExportScope } from "../../db/schema/person-export-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { logger } from "../../middleware/logger.js";
import { refuse } from "../../utils/appError.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { deleteStoredBytes } from "../attachment/attachmentServices.js";
import type { AttachmentType } from "../attachment/types.js";
import { organizationTimeZone } from "../organization/attendanceSettingsServices.js";
import { organizationDataStore } from "../organizationData/organizationDataStore.js";
import { employmentPhotosPrefix, removePhotoObjects } from "../directory/directoryPhotoServices.js";
import { getPersonContact } from "../person/personName.js";
import { removeExportRows } from "../personExport/personExportBuild.js";
import {
  adminAudience,
  endLockedEmployment,
  lockEmploymentForAdmin,
} from "./endEmploymentServices.js";
import { removeNoticesAboutErasedPerson } from "./erasedNotices.js";

/** Case, accents' composition and runs of spaces don't make a typed name wrong. */
export const sameName = (typed: string, expected: string): boolean => {
  const normalize = (value: string) =>
    value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return normalize(typed) === normalize(expected);
};

type StoredAttachment = Pick<AttachmentType, "id" | "storageKey" | "status">;

export type ErasedEmployment = {
  organizationId: string;
  /** Null for a person without an account. */
  userId: string | null;
  employmentIds: string[];
  attachments: StoredAttachment[];
  exportKeys: string[];
  notices: number;
};

type LockedEmployment = typeof employments.$inferSelect;

/** An open Employment ends today first, as End employment does, Reports to clears included. */
const endBeforeErase = async (
  employment: LockedEmployment,
  actorUserId: string,
  tx: DbTransaction
): Promise<void> => {
  if (employment.endedAt !== null) return;
  const { organizationId } = employment;
  const today = businessDateInZone(new Date(), await organizationTimeZone(organizationId, tx));
  await endLockedEmployment(
    employment,
    {
      endedOn: today,
      actorUserId,
      audience: await adminAudience(actorUserId, organizationId, tx),
    },
    tx
  );
};

/**
 * A person without an account is that one Employment: Erase deletes it, and
 * its profile, sealed Sections, photos and history go with it through the
 * cascade. They hold no bookings, quotas, memberships or attachments.
 */
const eraseAccountlessEmployment = async (
  employment: LockedEmployment,
  input: { confirmName: string; actorUserId: string },
  tx: DbTransaction
): Promise<ErasedEmployment> => {
  const { organizationId } = employment;
  if (!sameName(input.confirmName, employment.name ?? "")) {
    throw refuse(422, "NAME_MISMATCH", "The typed name does not match the person", {
      userId: input.actorUserId,
      employmentId: employment.id,
    });
  }
  await endBeforeErase(employment, input.actorUserId, tx);
  const exportKeys = await removeExportRows(
    organizationId,
    or(
      eq(personExports.subjectEmploymentId, employment.id),
      eq(personExports.scope, personExportScope.Organization)
    ),
    tx
  );
  await tx.delete(employments).where(eq(employments.id, employment.id));
  return {
    organizationId,
    userId: null,
    employmentIds: [employment.id],
    attachments: [],
    exportKeys,
    notices: 0,
  };
};

/**
 * Erase: removes everything one organization holds about a Deleted account,
 * across every spell, or a person without an account, which is one
 * Employment. Ends an open Employment first. Owner and org admins
 * only, on any plan, and only once the admin typed the person's name.
 *
 * The Read log's rows about the person stay, as do the stripped user row and
 * other people's records the person approved, created or changed: those now
 * read "Deleted account". Stored files go after the commit through
 * {@link removeErasedObjects}.
 */
export const eraseEmployment = async (
  input: { employmentId: string; confirmName: string; actorUserId: string },
  tx: DbTransaction
): Promise<ErasedEmployment> => {
  const context = { userId: input.actorUserId, employmentId: input.employmentId };
  const employment = await lockEmploymentForAdmin(input, tx);
  const { organizationId } = employment;

  if (employment.userId === null) return eraseAccountlessEmployment(employment, input, tx);
  if (employment.accountDeletedAt === null) {
    throw refuse(
      422,
      "ACCOUNT_NOT_DELETED",
      "Only a deleted account's organization data can be erased",
      context
    );
  }

  const userId = employment.userId;
  const person = await getPersonContact(userId, { organizationId }, tx);
  if (!person || !sameName(input.confirmName, person.name)) {
    throw refuse(422, "NAME_MISMATCH", "The typed name does not match the person", context);
  }

  await endBeforeErase(employment, input.actorUserId, tx);

  // Soft-deleted groups too: their rows still hold the person's records.
  const groupIds = (
    await tx.select({ id: groups.id }).from(groups).where(eq(groups.organizationId, organizationId))
  ).map((group) => group.id);

  const employmentIds = (
    await tx
      .select({ id: employments.id })
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)))
  ).map((row) => row.id);
  const notices = await removeNoticesAboutErasedPerson(
    { organizationId, userId, name: person.name, groupIds, employmentIds },
    tx
  );

  const removedAttachments = await tx
    .delete(attachments)
    .where(and(eq(attachments.organizationId, organizationId), eq(attachments.ownerUserId, userId)))
    .returning({
      id: attachments.id,
      storageKey: attachments.storageKey,
      status: attachments.status,
    });

  // Every Organization export holds the person too.
  const exportKeys = await removeExportRows(
    organizationId,
    or(
      eq(personExports.subjectUserId, userId),
      eq(personExports.scope, personExportScope.Organization)
    ),
    tx
  );

  const touchedGroupIds = new Set(groupIds);
  if (groupIds.length > 0) {
    await tx
      .delete(vacation)
      .where(and(eq(vacation.userId, userId), inArray(vacation.groupId, groupIds)));
    await tx
      .delete(userYearQuotas)
      .where(and(eq(userYearQuotas.userId, userId), inArray(userYearQuotas.groupId, groupIds)));
    await tx
      .delete(changesSchema)
      .where(and(eq(changesSchema.userId, userId), inArray(changesSchema.groupId, groupIds)));
    const removedMirrors = await tx
      .delete(groupMirrors)
      .where(
        and(
          eq(groupMirrors.userId, userId),
          or(
            inArray(groupMirrors.sourceGroupId, groupIds),
            inArray(groupMirrors.targetGroupId, groupIds)
          )
        )
      )
      .returning({ source: groupMirrors.sourceGroupId, target: groupMirrors.targetGroupId });
    for (const mirror of removedMirrors) {
      touchedGroupIds.add(mirror.source).add(mirror.target);
    }
    await tx
      .delete(groupUsers)
      .where(and(eq(groupUsers.userId, userId), inArray(groupUsers.groupId, groupIds)));

    // Hard deletes leave a phone no tombstone. A stamped group is sync reset
    // trigger 4 (docs/sync-pull.md), so every phone that showed these rows
    // takes a snapshot on its next pull and sweeps them.
    await tx
      .update(groups)
      .set({ updatedAt: new Date() })
      .where(inArray(groups.id, [...touchedGroupIds]));
  }

  await tx
    .delete(organizationUsers)
    .where(
      and(
        eq(organizationUsers.organizationId, organizationId),
        eq(organizationUsers.userId, userId)
      )
    );

  // Attendance sessions, breaks and events cascade from the Employment.
  const removedEmployments = await tx
    .delete(employments)
    .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)))
    .returning({ id: employments.id });

  return {
    organizationId,
    userId,
    employmentIds: removedEmployments.map((row) => row.id),
    attachments: removedAttachments,
    exportKeys,
    notices,
  };
};

/**
 * After the commit: the rows are gone, so no sweep would ever find these
 * files. A store failure is logged and the erase still stands.
 */
export const removeErasedObjects = async (erased: ErasedEmployment): Promise<void> => {
  const context = { organizationId: erased.organizationId, userId: erased.userId };
  for (const attachment of erased.attachments) {
    try {
      await deleteStoredBytes(attachment);
    } catch (error) {
      logger.error("erase.attachment_object_failed", {
        ...context,
        attachmentId: attachment.id,
        error,
      });
    }
  }
  for (const key of erased.exportKeys) {
    try {
      await organizationDataStore?.deleteObject(key);
    } catch (error) {
      logger.error("erase.export_object_failed", { ...context, key, error });
    }
  }
  await removePhotoObjects(
    erased.employmentIds.map((employmentId) =>
      employmentPhotosPrefix(erased.organizationId, employmentId)
    )
  );
};
