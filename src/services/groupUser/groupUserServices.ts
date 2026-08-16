import { db, type DbTransaction } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { and, asc, count, countDistinct, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  GroupUser,
  GroupUserInsertType,
  GroupUserListItem,
  GroupUserPermissions,
  InviteLink,
  InviteLinkInsertType,
  InviteLinkListItem,
} from "./types.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { buildUserSummary } from "../../utils/userPresentation.js";

export const getGroupUser = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<GroupUser | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(groupUsers)
    .where(
      and(
        eq(groupUsers.userId, userId),
        eq(groupUsers.groupId, groupId),
        isNull(groupUsers.deletedAt)
      )
    )
    .limit(1);

  return row;
};

export const createGroupUser = async (
  data: GroupUserInsertType,
  tx?: DbTransaction
): Promise<GroupUser | undefined> => {
  const [row] = await (tx ?? db).insert(groupUsers).values(data).onConflictDoNothing().returning();

  return row;
};

export const updateGroupUserPermissions = async (
  userId: string,
  groupId: string,
  permissions: GroupUserPermissions,
  tx?: DbTransaction
): Promise<GroupUser | undefined> => {
  const [row] = await (tx ?? db)
    .update(groupUsers)
    .set(permissions)
    .where(
      and(
        eq(groupUsers.groupId, groupId),
        eq(groupUsers.userId, userId),
        isNull(groupUsers.deletedAt)
      )
    )
    .returning();

  return row;
};

export const deleteGroupUser = async (
  id: string,
  tx?: DbTransaction
): Promise<GroupUser | undefined> => {
  const [row] = await (tx ?? db)
    .update(groupUsers)
    .set({
      deletedAt: new Date(),
    })
    .where(and(eq(groupUsers.id, id), isNull(groupUsers.deletedAt)))
    .returning();

  return row;
};

export const getAllGroupsForUser = async (userId: string): Promise<{ groupId: string }[]> => {
  return db
    .select({
      groupId: groupUsers.groupId,
    })
    .from(groupUsers)
    .where(and(eq(groupUsers.userId, userId), isNull(groupUsers.deletedAt)));
};

/** The groups the user administers — the reach of any admin-only action. */
export const getAdminGroupIdsForUser = async (
  userId: string,
  tx?: DbTransaction
): Promise<string[]> => {
  const rows = await (tx ?? db)
    .select({ groupId: groupUsers.groupId })
    .from(groupUsers)
    .where(
      and(
        eq(groupUsers.userId, userId),
        eq(groupUsers.adminAccess, true),
        isNull(groupUsers.deletedAt)
      )
    );

  return rows.map((row) => row.groupId);
};

/** Active (user, group) membership pairs, for cross-referencing many at once. */
export const getMembershipPairs = async (
  userIds: string[],
  groupIds: string[],
  tx?: DbTransaction
): Promise<{ userId: string; groupId: string }[]> => {
  if (userIds.length === 0 || groupIds.length === 0) return [];
  return (tx ?? db)
    .select({ userId: groupUsers.userId, groupId: groupUsers.groupId })
    .from(groupUsers)
    .where(
      and(
        inArray(groupUsers.userId, userIds),
        inArray(groupUsers.groupId, groupIds),
        isNull(groupUsers.deletedAt)
      )
    );
};

/**
 * Lists the active members of a group together with their identity, so the
 * members screen can show names instead of raw user ids.
 */
export const getGroupUsers = async (groupId: string): Promise<GroupUserListItem[]> => {
  const rows = await db
    .select({
      id: groupUsers.id,
      groupId: groupUsers.groupId,
      userId: groupUsers.userId,
      viewAccess: groupUsers.viewAccess,
      adminAccess: groupUsers.adminAccess,
      approverAccess: groupUsers.approverAccess,
      controlledUser: groupUsers.controlledUser,
      deletedAt: groupUsers.deletedAt,
      createdAt: groupUsers.createdAt,
      updatedAt: groupUsers.updatedAt,
      userName: user.name,
      email: user.email,
    })
    .from(groupUsers)
    .innerJoin(user, eq(groupUsers.userId, user.id))
    .where(and(eq(groupUsers.groupId, groupId), isNull(groupUsers.deletedAt)))
    .orderBy(asc(user.name));

  return rows.map(({ userName, ...rest }) => ({
    ...rest,
    user: buildUserSummary({ id: rest.userId, name: userName }),
  }));
};

/**
 * Returns the number of distinct users that belong to any of the supplied
 * groups. Used by the dashboard "team size" stat card.
 */
export const countDistinctUsersInGroups = async (groupIds: string[]): Promise<number> => {
  if (groupIds.length === 0) return 0;
  const [row] = await db
    .select({ value: countDistinct(groupUsers.userId) })
    .from(groupUsers)
    .where(and(inArray(groupUsers.groupId, groupIds), isNull(groupUsers.deletedAt)));
  return Number(row?.value ?? 0);
};

export const createInviteLink = async (
  data: InviteLinkInsertType,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db).insert(inviteLink).values(data).returning();

  return row;
};

export const getInviteLinksForGroup = async (groupId: string): Promise<InviteLink[]> => {
  return db.select().from(inviteLink).where(eq(inviteLink.groupId, groupId));
};

/**
 * The group's invites that can still be redeemed, newest first — what the
 * members screen lists so an admin can see who has an outstanding invite and
 * re-read or revoke the code.
 */
export const getOpenInvitesForGroup = async (groupId: string): Promise<InviteLinkListItem[]> => {
  const inviter = alias(user, "invitedByUser");

  const rows = await db
    .select({
      id: inviteLink.id,
      groupId: inviteLink.groupId,
      code: inviteLink.code,
      email: inviteLink.email,
      invitedByUserId: inviteLink.invitedByUserId,
      usedAt: inviteLink.usedAt,
      revokedAt: inviteLink.revokedAt,
      expiresAt: inviteLink.expiresAt,
      createdAt: inviteLink.createdAt,
      updatedAt: inviteLink.updatedAt,
      invitedByName: inviter.name,
    })
    .from(inviteLink)
    .leftJoin(inviter, eq(inviteLink.invitedByUserId, inviter.id))
    .where(
      and(
        eq(inviteLink.groupId, groupId),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt),
        gt(inviteLink.expiresAt, new Date())
      )
    )
    .orderBy(desc(inviteLink.createdAt));

  return rows;
};

export const getInviteLinkById = async (inviteId: string): Promise<InviteLink | undefined> => {
  const [row] = await db.select().from(inviteLink).where(eq(inviteLink.id, inviteId)).limit(1);

  return row;
};

/**
 * Retires the open invite for (group, email) if there is one, so re-inviting
 * the same address issues a fresh code instead of tripping the partial unique
 * index — and so the superseded code stops working.
 */
export const revokeOpenInviteForEmail = async (
  groupId: string,
  email: string,
  tx?: DbTransaction
): Promise<void> => {
  await (tx ?? db)
    .update(inviteLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(inviteLink.groupId, groupId),
        eq(inviteLink.email, email),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt)
      )
    );
};

export const revokeInviteLink = async (inviteId: string): Promise<InviteLink | undefined> => {
  const [row] = await db
    .update(inviteLink)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(inviteLink.id, inviteId), isNull(inviteLink.usedAt), isNull(inviteLink.revokedAt))
    )
    .returning();

  return row;
};

export const getInviteLinkByCode = async (
  code: string,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(inviteLink)
    .where(eq(inviteLink.code, code))
    .limit(1);

  return row;
};

/**
 * Marks the code as redeemed. The `usedAt IS NULL` predicate is what makes an
 * invite single-use even under concurrent redemptions: the second update
 * matches no row and the caller rolls back.
 */
export const useInviteLink = async (
  code: string,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db)
    .update(inviteLink)
    .set({ usedAt: new Date() })
    .where(and(eq(inviteLink.code, code), isNull(inviteLink.usedAt), isNull(inviteLink.revokedAt)))
    .returning();

  return row;
};

export const countActiveMembersInGroup = async (
  groupId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ value: count() })
    .from(groupUsers)
    .where(and(eq(groupUsers.groupId, groupId), isNull(groupUsers.deletedAt)));
  return Number(row?.value ?? 0);
};

/**
 * Open (redeemable) invites for a group. The billing member-cap guard counts
 * these alongside live members, otherwise parallel redemptions overfill a
 * group past its plan limit.
 */
export const countOpenInvitesForGroup = async (
  groupId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ value: count() })
    .from(inviteLink)
    .where(
      and(
        eq(inviteLink.groupId, groupId),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt),
        gt(inviteLink.expiresAt, new Date())
      )
    );
  return Number(row?.value ?? 0);
};
