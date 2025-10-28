import { db, type DbTransaction } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { and, eq, isNull } from "drizzle-orm";
import type {
  GroupUser,
  GroupUserInsertType,
  GroupUserPermissions,
} from "./types.js";

/**
 * Retrieves a user and their association with a specified group.
 *
 * This function fetches the user's details within the context of a particular group,
 * excluding records that have been marked as deleted. If no matching record is found,
 * it returns undefined.
 *
 * @param {string} userId - The unique identifier of the user.
 * @param {string} groupId - The unique identifier of the group.
 * @returns {Promise<GroupUser | undefined>} A promise that resolves to the user's group association details,
 * or undefined if no matching record is found.
 */
export const getGroupUser = async (
  userId: string,
  groupId: string
): Promise<GroupUser | undefined> => {
  const [row] = await db
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

/**
 * Asynchronously creates a new user in a group within the database.
 *
 * Inserts a new entry into the `groupUsers` table using the provided data.
 * If a conflict occurs (e.g., duplicate entry), the operation will do nothing.
 * Returns the inserted row if insertion is successful, otherwise `undefined`.
 *
 * @param {GroupUserInsertType} data - The data for the new group user to be inserted.
 * @param {DbTransaction} [tx] - Optional database transaction to use for the operation. If not provided, the default database connection is used.
 * @returns {Promise<GroupUser | undefined>} A promise that resolves to the inserted group user object or `undefined` if the insertion failed due to a conflict.
 */
export const createGroupUser = async (
  data: GroupUserInsertType,
  tx?: DbTransaction
): Promise<GroupUser | undefined> => {
  const [row] = await (tx ?? db)
    .insert(groupUsers)
    .values(data)
    .onConflictDoNothing()
    .returning();

  return row;
};

/**
 * Updates the permissions of a user in a group.
 *
 * This function updates the permissions of a user in a group identified by the given ID.
 * It modifies the group's user permissions in the database and returns the updated
 * group user record if the update operation is successful. If no matching user is found,
 * it returns undefined.
 *
 * @param {string} id - The unique identifier of the group user whose permissions are to be updated.
 * @param {GroupUserPermissions} permissions - The new permissions to be set for the group user.
 * @returns {Promise<GroupUser | undefined>} A promise that resolves to the updated group user object
 * if the update succeeds, or undefined if no record is found.
 */
export const updateGroupUserPermissions = async (
  id: string,
  permissions: GroupUserPermissions
): Promise<GroupUser | undefined> => {
  const [row] = await db
    .update(groupUsers)
    .set(permissions)
    .where(and(eq(groupUsers.id, id), isNull(groupUsers.deletedAt)))
    .returning();

  return row;
};

/**
 * Deletes a group user by marking it as deleted in the database.
 *
 * This function updates the `deletedAt` field of a group user with the specified ID
 * to the current date and time, effectively marking the user as deleted.
 * The updated row is returned or undefined if no row is affected.
 *
 * @param {string} id - The unique identifier of the group user to delete.
 * @returns {Promise<GroupUser | undefined>} A promise that resolves to the updated group user object
 * or undefined if the ID does not match any existing user.
 */
export const deleteGroupUser = async (
  id: string
): Promise<GroupUser | undefined> => {
  const [row] = await db
    .update(groupUsers)
    .set({
      deletedAt: new Date(),
    })
    .where(and(eq(groupUsers.id, id), isNull(groupUsers.deletedAt)))
    .returning();

  return row;
};

/**
 * Retrieves all groups associated with a given user.
 *
 * This asynchronous function fetches an array of group objects containing the group IDs
 * for a specified user. It filters out groups that have been marked as deleted.
 *
 * @param {string} userId - The unique identifier of the user for whom to retrieve groups.
 * @returns {Promise<{ groupId: string }[]>} A promise that resolves to an array of objects,
 * each containing a `groupId` property representing the group ID associated with the user.
 */
export const getAllGroupsForUser = async (
  userId: string
): Promise<{ groupId: string }[]> => {
  return db
    .select({
      groupId: groupUsers.groupId,
    })
    .from(groupUsers)
    .where(and(eq(groupUsers.userId, userId), isNull(groupUsers.deletedAt)));
};
