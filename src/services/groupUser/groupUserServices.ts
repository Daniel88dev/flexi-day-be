import { db, type DbTransaction } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { and, asc, countDistinct, eq, inArray, isNull } from "drizzle-orm";
import type {
  GroupUser,
  GroupUserInsertType,
  GroupUserListItem,
  GroupUserPermissions,
  InviteLink,
  InviteLinkInsertType,
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

export const deleteGroupUser = async (id: string): Promise<GroupUser | undefined> => {
  const [row] = await db
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
  data: InviteLinkInsertType
): Promise<InviteLink | undefined> => {
  const [row] = await db.insert(inviteLink).values(data).returning();

  return row;
};

export const getInviteLinksForGroup = async (groupId: string): Promise<InviteLink[]> => {
  return db.select().from(inviteLink).where(eq(inviteLink.groupId, groupId));
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

export const useInviteLink = async (
  code: string,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db)
    .update(inviteLink)
    .set({ usedAt: new Date() })
    .where(and(eq(inviteLink.code, code), isNull(inviteLink.usedAt)))
    .returning();

  return row;
};
