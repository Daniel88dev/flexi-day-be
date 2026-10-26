import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { account, session, twoFactor, user, verification } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { subscriptions, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { supportAccess } from "../../db/schema/support-access-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import {
  attendanceBreaks,
  attendanceClosedBy,
  attendanceEventType,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { calendarConnection } from "../../db/schema/calendar-connection-schema.js";
import { calendarSync } from "../../db/schema/calendar-sync-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { appendAttendanceEvent, lockEmployment } from "../attendance/attendanceServices.js";
import { removeBirthday } from "../birthday/birthdayServices.js";
import { createVacationEvents } from "../vacationEvent/vacationEventServices.js";
import { attachments } from "../../db/schema/attachment-schema.js";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";
import { deleteStoredBytes } from "../attachment/attachmentServices.js";
import { lockOrganization } from "../organization/organizationServices.js";
import { updateGroupManager } from "../group/groupServices.js";
import type { AttachmentType } from "../attachment/types.js";
import { DeletionRefusal, type DeletionBlocker, type DeletionConfirmation } from "./types.js";

// A group in someone else's organization passes to that organization's owner,
// so only the caller's own organizations can block.
const groupsWithOtherMembers = async (
  userId: string,
  executor: DbTransaction | typeof db
): Promise<DeletionBlocker[]> => {
  const rows = await executor
    .select({ id: groups.id, name: groups.groupName, others: count(groupUsers.id) })
    .from(groups)
    .innerJoin(
      organizations,
      and(eq(organizations.id, groups.organizationId), eq(organizations.ownerUserId, userId))
    )
    .innerJoin(
      groupUsers,
      and(
        eq(groupUsers.groupId, groups.id),
        isNull(groupUsers.deletedAt),
        ne(groupUsers.userId, userId)
      )
    )
    .innerJoin(user, and(eq(user.id, groupUsers.userId), isNull(user.deletedAt)))
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
        isNull(employments.accountDeletedAt),
        // Like a Deleted account, a person without an account cannot leave, so they never block.
        isNotNull(employments.userId),
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

export type HandedOverGroup = {
  groupId: string;
  groupName: string;
  organizationId: string;
  ownerUserId: string;
};

export type DeletedAccountRows = {
  groups: number;
  /** Live groups the person managed in other people's organizations, now managed by the owner. */
  handedOverGroups: HandedOverGroup[];
  organizations: number;
  /** The deleted organizations; hand them to `removeOrganizationExports` after the commit. */
  organizationIds: string[];
  /** Pending days cancelled with the reason {@link ACCOUNT_DELETED_REASON}. */
  cancelledRequests: number;
  /** Collected before their rows went; hand them to `removeAttachmentObjects` after the commit. */
  attachments: StoredAttachment[];
};

export const ACCOUNT_DELETED_REASON = "account deleted";

/** The email a stripped user row keeps: unique, and undeliverable by its reserved domain. */
export const deletedAccountEmail = (userId: string) => `${userId}@deleted.invalid`;

/**
 * Closes the person's running clocks at `at`, as the sweep would: closed by
 * the sweep, so the day is flagged for an admin to look at.
 */
const closeOpenSessions = async (userId: string, at: Date, tx: DbTransaction) => {
  const open = await tx
    .select({ id: attendanceSessions.id, employmentId: attendanceSessions.employmentId })
    .from(attendanceSessions)
    .innerJoin(employments, eq(employments.id, attendanceSessions.employmentId))
    .where(
      and(
        eq(employments.userId, userId),
        isNull(attendanceSessions.endedAt),
        isNull(attendanceSessions.deletedAt)
      )
    );

  for (const session of open) {
    await lockEmployment(session.employmentId, tx);
    const closedBreaks = await tx
      .update(attendanceBreaks)
      .set({ endedAt: sql`greatest(${attendanceBreaks.startedAt}, ${at})` })
      .where(and(eq(attendanceBreaks.sessionId, session.id), isNull(attendanceBreaks.endedAt)))
      .returning({ id: attendanceBreaks.id });
    await tx
      .update(attendanceSessions)
      .set({
        endedAt: sql`greatest(${attendanceSessions.startedAt}, ${at})`,
        closedBy: attendanceClosedBy.Sweep,
      })
      .where(eq(attendanceSessions.id, session.id));
    await appendAttendanceEvent(
      {
        sessionId: session.id,
        eventType: attendanceEventType.ClockOut,
        changedByUserId: null,
        before: { endedAt: null, closedBy: null },
        after: {
          endedAt: at,
          closedBy: attendanceClosedBy.Sweep,
          closedOpenBreakId: closedBreaks[0]?.id ?? null,
          reason: ACCOUNT_DELETED_REASON,
        },
      },
      tx
    );
  }
};

/** Pending days get a cancelled event with no actor, and nobody is told. */
const cancelPendingRequests = async (userId: string, at: Date, tx: DbTransaction) => {
  const cancelled = await tx
    .update(vacation)
    .set({ deletedAt: at, deletedByUserId: null })
    .where(
      and(
        eq(vacation.userId, userId),
        isNull(vacation.approvedAt),
        isNull(vacation.rejectedAt),
        isNull(vacation.deletedAt)
      )
    )
    .returning({ id: vacation.id });

  await createVacationEvents(
    cancelled.map((row) => ({
      id: generateRandomUUID(),
      vacationId: row.id,
      eventType: vacationEventType.Cancelled,
      actorUserId: null,
      reason: ACCOUNT_DELETED_REASON,
    })),
    tx
  );
  return cancelled.length;
};

/**
 * The owner takes over every live group the person managed in someone else's
 * organization. The owner gets no membership, so no quota and no seat, and the
 * outgoing manager's Employment is left open: no `syncEmployment` for them.
 */
const handManagedGroupsToOwners = async (
  userId: string,
  tx: DbTransaction
): Promise<HandedOverGroup[]> => {
  const managed = await tx
    .select({
      groupId: groups.id,
      groupName: groups.groupName,
      organizationId: groups.organizationId,
      ownerUserId: organizations.ownerUserId,
    })
    .from(groups)
    .innerJoin(organizations, eq(organizations.id, groups.organizationId))
    .where(
      and(
        eq(groups.managerUserId, userId),
        isNull(groups.deletedAt),
        ne(organizations.ownerUserId, userId)
      )
    )
    .orderBy(asc(groups.id));

  for (const group of managed) {
    await updateGroupManager(group.groupId, group.ownerUserId, tx, { syncOutgoing: false });
  }
  return managed;
};

/** Account data: everything Flexi Day holds for the person themselves. */
const deleteAccountData = async (userId: string, tx: DbTransaction) => {
  // Push registrations cascade with their sessions.
  await tx.delete(session).where(eq(session.userId, userId));
  await tx.delete(account).where(eq(account.userId, userId));
  await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
  await tx.delete(verification).where(eq(verification.value, userId));
  await tx.delete(userSettings).where(eq(userSettings.userId, userId));
  await tx.delete(notifications).where(eq(notifications.userId, userId));
  await tx.delete(calendarConnection).where(eq(calendarConnection.userId, userId));
  await tx.delete(calendarSync).where(eq(calendarSync.userId, userId));
  // A tombstone rather than a delete, so the phones that synced it drop it.
  await removeBirthday(userId, tx);
};

/**
 * Deletes the account inside `tx`, or throws 409 `DELETION_BLOCKED` having
 * changed nothing. Account data goes and the user row is stripped to its id.
 * Organization data in other people's organizations stays: every Employment
 * stays open with `accountDeletedAt`, memberships lose their flags, and
 * bookings, quotas and the change log keep pointing at the id.
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

  // A write that references the user (a new organization, an approver slot, a
  // booking on their behalf) now waits on this row and then sees it stripped.
  const [self] = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .for("update");
  if (!self) {
    throw new AppError({ message: "Unauthorized", code: 401, logging: true, context: { userId } });
  }

  // Read again under the user lock: an organization created before it is ours to delete too.
  const ownedIds = await ownedBy();

  const blockers = await getDeletionBlockers(userId, tx);
  if (blockers.length > 0) {
    throw new AppError({
      message: "The account cannot be deleted yet",
      code: 409,
      logging: false,
      publicContext: { reason: DeletionRefusal.DeletionBlocked, blockers },
    });
  }

  const removedAttachments =
    ownedIds.length === 0
      ? []
      : await tx
          .select({
            id: attachments.id,
            storageKey: attachments.storageKey,
            status: attachments.status,
          })
          .from(attachments)
          .where(inArray(attachments.organizationId, ownedIds));

  const now = new Date();

  await tx
    .update(groups)
    .set({ mainApprovalUser: null })
    .where(eq(groups.mainApprovalUser, userId));
  await tx
    .update(groups)
    .set({ tempApprovalUser: null })
    .where(eq(groups.tempApprovalUser, userId));

  await tx
    .update(groupUsers)
    .set({ viewAccess: false, adminAccess: false, approverAccess: false })
    .where(and(eq(groupUsers.userId, userId), isNull(groupUsers.deletedAt)));

  // No `syncEmployment`: the Employment stays open even when this was its only link.
  await tx
    .update(organizationUsers)
    .set({ deletedAt: now })
    .where(and(eq(organizationUsers.userId, userId), isNull(organizationUsers.deletedAt)));

  const cancelledRequests = await cancelPendingRequests(userId, now, tx);
  await closeOpenSessions(userId, now, tx);

  // Before the strip: the `employments_follow_user` trigger skips stamped rows,
  // so the copy keeps the name the organization knew.
  await tx
    .update(employments)
    .set({ accountDeletedAt: now })
    .where(and(eq(employments.userId, userId), isNull(employments.accountDeletedAt)));

  const handedOverGroups = await handManagedGroupsToOwners(userId, tx);

  let deletedGroups = 0;
  if (ownedIds.length > 0) {
    deletedGroups = (
      await tx
        .delete(groups)
        .where(inArray(groups.organizationId, ownedIds))
        .returning({ id: groups.id })
    ).length;
    await tx.delete(subscriptions).where(inArray(subscriptions.organizationId, ownedIds));
    await tx.delete(organizations).where(inArray(organizations.id, ownedIds));
  }

  await deleteAccountData(userId, tx);

  await tx
    .update(user)
    .set({
      name: "",
      email: deletedAccountEmail(userId),
      emailVerified: false,
      twoFactorEnabled: false,
      image: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(user.id, userId));

  return {
    groups: deletedGroups,
    handedOverGroups,
    organizations: ownedIds.length,
    organizationIds: ownedIds,
    cancelledRequests,
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
