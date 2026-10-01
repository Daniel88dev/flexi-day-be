import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type Column,
} from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { account, session, user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { subscriptions, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { supportAccess } from "../../db/schema/support-access-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { attachments } from "../../db/schema/attachment-schema.js";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";
import { deleteStoredBytes } from "../attachment/attachmentServices.js";
import { lockOrganization } from "../organization/organizationServices.js";
import type { AttachmentType } from "../attachment/types.js";
import { DeletionRefusal, type DeletionBlocker, type DeletionConfirmation } from "./types.js";

const groupsWithOtherMembers = async (
  userId: string,
  executor: DbTransaction | typeof db
): Promise<DeletionBlocker[]> => {
  const rows = await executor
    .select({ id: groups.id, name: groups.groupName, others: count(groupUsers.id) })
    .from(groups)
    .innerJoin(
      groupUsers,
      and(
        eq(groupUsers.groupId, groups.id),
        isNull(groupUsers.deletedAt),
        ne(groupUsers.userId, userId)
      )
    )
    .where(and(eq(groups.managerUserId, userId), isNull(groups.deletedAt)))
    .groupBy(groups.id, groups.groupName)
    .orderBy(asc(groups.groupName), asc(groups.id));

  return rows.map((row) => ({
    kind: "GROUP_HAS_MEMBERS",
    groupId: row.id,
    groupName: row.name,
    otherMembers: row.others,
  }));
};

const organizationsWithOtherMembers = async (
  userId: string,
  executor: DbTransaction | typeof db
): Promise<DeletionBlocker[]> => {
  const rows = await executor
    .select({ id: organizations.id, name: organizations.name, others: count(employments.id) })
    .from(organizations)
    .innerJoin(
      employments,
      and(
        eq(employments.organizationId, organizations.id),
        isNull(employments.endedAt),
        ne(employments.userId, userId)
      )
    )
    .where(eq(organizations.ownerUserId, userId))
    .groupBy(organizations.id, organizations.name)
    .orderBy(asc(organizations.name), asc(organizations.id));

  return rows.map((row) => ({
    kind: "ORGANIZATION_HAS_MEMBERS",
    organizationId: row.id,
    organizationName: row.name,
    otherMembers: row.others,
  }));
};

const renewingSubscriptions = async (
  userId: string,
  executor: DbTransaction | typeof db
): Promise<DeletionBlocker[]> => {
  const rows = await executor
    .select({ id: organizations.id, name: organizations.name })
    .from(subscriptions)
    .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
    .where(
      and(
        eq(organizations.ownerUserId, userId),
        isNotNull(subscriptions.paddleSubscriptionId),
        sql`${subscriptions.status} IS DISTINCT FROM ${subscriptionStatus.Canceled}`,
        isNull(subscriptions.cancelAt)
      )
    )
    .orderBy(asc(organizations.name), asc(organizations.id));

  return rows.map((row) => ({
    kind: "SUBSCRIPTION_RENEWING",
    organizationId: row.id,
    organizationName: row.name,
  }));
};

// A former support admin, dropped from the allowlist, still has an audit trail
// that has to survive, so the rows count as well as the configured id.
const isSupportAdmin = async (
  userId: string,
  executor: DbTransaction | typeof db
): Promise<boolean> => {
  if (config.support?.userIds.includes(userId)) return true;
  const [row] = await executor
    .select({ id: supportAccess.id })
    .from(supportAccess)
    .where(eq(supportAccess.userId, userId))
    .limit(1);
  return Boolean(row);
};

export const getDeletionBlockers = async (
  userId: string,
  tx?: DbTransaction
): Promise<DeletionBlocker[]> => {
  const executor = tx ?? db;
  return [
    ...(await groupsWithOtherMembers(userId, executor)),
    ...(await organizationsWithOtherMembers(userId, executor)),
    ...(await renewingSubscriptions(userId, executor)),
    ...((await isSupportAdmin(userId, executor)) ? [{ kind: "SUPPORT_ADMIN" as const }] : []),
  ];
};

/** The stored hash of the user's email-and-password account, or null for a social-only user. */
export const getCredentialPasswordHash = async (userId: string): Promise<string | null> => {
  const [row] = await db
    .select({ password: account.password })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, "credential"),
        isNotNull(account.password)
      )
    )
    .limit(1);
  return row?.password ?? null;
};

export const getDeletionConfirmation = async (userId: string): Promise<DeletionConfirmation> =>
  (await getCredentialPasswordHash(userId)) ? "password" : "recent-sign-in";

export const getSessionCreatedAt = async (sessionId: string): Promise<Date | undefined> => {
  const [row] = await db
    .select({ createdAt: session.createdAt })
    .from(session)
    .where(eq(session.id, sessionId))
    .limit(1);
  return row?.createdAt;
};

type StoredAttachment = Pick<AttachmentType, "id" | "storageKey" | "status">;

export type DeletedAccountRows = {
  groups: number;
  organizations: number;
  /** Collected before their rows went; hand them to `removeAttachmentObjects` after the commit. */
  attachments: StoredAttachment[];
};

/**
 * Deletes the account and everything that goes with it inside `tx`, or throws
 * 409 `DELETION_BLOCKED` having changed nothing.
 */
export const deleteAccountRows = async (
  userId: string,
  tx: DbTransaction
): Promise<DeletedAccountRows> => {
  const ownedBy = async () =>
    (
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.ownerUserId, userId))
    ).map((row) => row.id);

  const managed = await tx
    .select({ organizationId: groups.organizationId })
    .from(groups)
    .where(eq(groups.managerUserId, userId));

  // Every join, invite redemption and admin grant takes `lockOrganization`, so
  // holding these rows makes the blocker check below the final word. Sorted, so
  // two deletions touching the same organizations cannot deadlock, and before
  // the user row, the order a join that references the user takes them in.
  const lockIds = [
    ...new Set([...(await ownedBy()), ...managed.map((row) => row.organizationId)]),
  ].sort();
  for (const organizationId of lockIds) {
    await lockOrganization(organizationId, tx);
  }

  // An insert that references the user (a new organization, an approver slot)
  // now waits on this row and then fails, rather than committing a reference
  // the deletes below never saw.
  const [self] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for("update");
  if (!self) {
    throw new AppError({ message: "Unauthorized", code: 401, logging: true, context: { userId } });
  }

  // Read again under the user lock: an organization created before it is ours to delete too.
  const ownedIds = await ownedBy();
  const userOrOwned = (userColumn: Column, organizationColumn: Column) =>
    ownedIds.length > 0
      ? or(eq(userColumn, userId), inArray(organizationColumn, ownedIds))
      : eq(userColumn, userId);

  const blockers = await getDeletionBlockers(userId, tx);
  if (blockers.length > 0) {
    throw new AppError({
      message: "The account cannot be deleted yet",
      code: 409,
      logging: false,
      publicContext: { reason: DeletionRefusal.DeletionBlocked, blockers },
    });
  }

  const removedAttachments = await tx
    .select({
      id: attachments.id,
      storageKey: attachments.storageKey,
      status: attachments.status,
    })
    .from(attachments)
    .where(userOrOwned(attachments.ownerUserId, attachments.organizationId));

  await tx
    .update(groups)
    .set({ mainApprovalUser: null })
    .where(eq(groups.mainApprovalUser, userId));
  await tx
    .update(groups)
    .set({ tempApprovalUser: null })
    .where(eq(groups.tempApprovalUser, userId));

  await tx
    .update(changesSchema)
    .set({ changingUserId: null, changingUserDeleted: true })
    .where(eq(changesSchema.changingUserId, userId));

  const deletedGroups = await tx
    .delete(groups)
    .where(userOrOwned(groups.managerUserId, groups.organizationId))
    .returning({ id: groups.id });

  if (ownedIds.length > 0) {
    await tx.delete(subscriptions).where(inArray(subscriptions.organizationId, ownedIds));
    await tx.delete(organizations).where(inArray(organizations.id, ownedIds));
  }

  await tx.delete(user).where(eq(user.id, userId));

  return {
    groups: deletedGroups.length,
    organizations: ownedIds.length,
    attachments: removedAttachments,
  };
};

/**
 * The attachment objects go after the commit: their rows are gone by then, so
 * the retention sweep could never find them, and the account is gone whether
 * or not the store answers.
 */
export const removeAttachmentObjects = async (
  userId: string,
  removed: StoredAttachment[]
): Promise<void> => {
  for (const attachment of removed) {
    try {
      await deleteStoredBytes(attachment);
    } catch (error) {
      logger.error("Account deletion could not remove an attachment object", {
        userId,
        attachmentId: attachment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
