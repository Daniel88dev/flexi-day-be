import { db, type DbTransaction } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { and, asc, count, countDistinct, eq, inArray, isNull } from "drizzle-orm";
import type {
  GroupUser,
  GroupUserInsertType,
  GroupUserListItem,
  GroupUserPermissions,
} from "./types.js";
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

export const getAllGroupsForUser = async (
  userId: string
): Promise<{ groupId: string; adminAccess: boolean; approverAccess: boolean }[]> => {
  return db
    .select({
      groupId: groupUsers.groupId,
      adminAccess: groupUsers.adminAccess,
      approverAccess: groupUsers.approverAccess,
    })
    .from(groupUsers)
    .where(and(eq(groupUsers.userId, userId), isNull(groupUsers.deletedAt)));
};

/** Active-member headcount per group, one grouped query for the whole list. */
export const countMembersByGroup = async (groupIds: string[]): Promise<Map<string, number>> => {
  if (groupIds.length === 0) return new Map();
  const rows = await db
    .select({ groupId: groupUsers.groupId, members: count() })
    .from(groupUsers)
    .where(and(inArray(groupUsers.groupId, groupIds), isNull(groupUsers.deletedAt)))
    .groupBy(groupUsers.groupId);
  return new Map(rows.map((row) => [row.groupId, row.members]));
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

/**
 * How many of an organization's live groups the user still actively belongs to.
 * Zero means they are no longer one of the organization's people, which is what
 * an org-admin grant is scoped to.
 */
export const countActiveMembershipsInOrganization = async (
  userId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ value: count() })
    .from(groupUsers)
    .innerJoin(groups, eq(groupUsers.groupId, groups.id))
    .where(
      and(
        eq(groupUsers.userId, userId),
        eq(groups.organizationId, organizationId),
        isNull(groupUsers.deletedAt),
        isNull(groups.deletedAt)
      )
    );

  return Number(row?.value ?? 0);
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
