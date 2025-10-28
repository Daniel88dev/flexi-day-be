import type { GroupInsertType, GroupType } from "./types.js";
import { db, type DbTransaction } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { user } from "../../db/schema/auth-schema.js";
import { alias } from "drizzle-orm/pg-core";

/**
 * Retrieves a group from the database based on the provided group ID.
 *
 * @param {string} groupId - The unique identifier of the group to retrieve.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the group object
 *                                           if found and not marked as deleted, or undefined if not found.
 */
export const getGroup = async (
  groupId: string
): Promise<GroupType | undefined> => {
  const [row] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)));

  return row;
};

/**
 * Retrieves all groups from the database that match the specified group IDs.
 * Filters out groups that have been marked as deleted.
 *
 * @param {string[]} groupIds - An array of group IDs to fetch from the database.
 * @returns {Promise<GroupType[]>} A promise that resolves with an array of groups matching the provided IDs.
 */
export const getAllGroups = async (
  groupIds: string[]
): Promise<GroupType[]> => {
  return db
    .select()
    .from(groups)
    .where(and(inArray(groups.id, groupIds), isNull(groups.deletedAt)));
};

/**
 * Creates a new group entry in the database.
 *
 * This function inserts a new group record into the groups table and returns the newly created group object.
 * If a database transaction instance is provided, the operation will be executed within the given transaction context.
 *
 * @param {GroupInsertType} data - The data object representing the group to be inserted.
 * @param {DbTransaction} [tx] - Optional database transaction instance for handling the operation.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the newly created group object, or undefined if the operation fails.
 */
export const createGroup = async (
  data: GroupInsertType,
  tx?: DbTransaction
): Promise<GroupType | undefined> => {
  const [row] = await (tx ?? db).insert(groups).values(data).returning();
  return row;
};

/**
 * Updates the manager of a specific group with a new manager.
 *
 * @param {string} groupId - The unique identifier of the group to update.
 * @param {string} newManagerId - The unique identifier of the new manager to assign to the group.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the updated group object if the update is successful,
 * or undefined if the group is not found or the update fails.
 */
export const updateGroupManager = async (
  groupId: string,
  newManagerId: string
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      managerUserId: newManagerId,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

/**
 * Updates the approval users for a specified group.
 *
 * This function allows updating both the main approval user and the temporary approval user
 * for a group identified by its unique group ID. The update is performed in the database,
 * and the modified group information is returned if the update is successful.
 *
 * @param {string} groupId - The unique identifier of the group to update.
 * @param {string | null} newMainApprovalUser - The new main approval user ID. Use `null` to unset the main approval user.
 * @param {string | null} newTempApprovalUser - The new temporary approval user ID. Use `null` to unset the temporary approval user.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the updated group object, or `undefined` if no group was updated.
 */
export const updateGroupApprovalUsers = async (
  groupId: string,
  newMainApprovalUser: string | null,
  newTempApprovalUser: string | null
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      mainApprovalUser: newMainApprovalUser,
      tempApprovalUser: newTempApprovalUser,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

/**
 * Deletes a group by marking it as deleted in the database.
 *
 * This function updates the `deletedAt` field of the specified group
 * to the current date. The group is identified by its unique `groupId`.
 * If the operation is successful, the updated group record is returned.
 * If no group with the specified ID exists, the function returns `undefined`.
 *
 * @param {string} groupId - The unique identifier of the group to delete.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the updated group record,
 * or `undefined` if no group with the given ID is found.
 */
export const deleteGroup = async (
  groupId: string
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      deletedAt: new Date(),
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

/**
 * Updates the group quotas for vacation and home office days.
 *
 * This function updates the default vacation and home office days for a specified group.
 * The updated quotas are stored in the database, and the updated group object is returned.
 *
 * @param {string} groupId - The unique identifier of the group to be updated.
 * @param {number} newVacation - The new number of default vacation days to be set for the group.
 * @param {number} newHomeOffice - The new number of default home office days to be set for the group.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the updated group object if the operation is successful, or `undefined` if no matching group is found.
 */
export const updateGroupQuotas = async (
  groupId: string,
  newVacation: number,
  newHomeOffice: number
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      defaultVacationDays: newVacation,
      defaultHomeOfficeDays: newHomeOffice,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

type GroupApprovalUsersType = {
  groupId: string;
  groupName: string;
  mainApprovalUserId: string | null;
  mainApprovalUserName: string | null;
  mainApprovalUserEmail: string | null;
  tempApprovalUserId: string | null;
  tempApprovalUserName: string | null;
  tempApprovalUserEmail: string | null;
};

export const getApprovalUsers = async (
  groupId: string
): Promise<GroupApprovalUsersType | undefined> => {
  const mainApprovalUser = alias(user, "mainApprovalUser");
  const tempApprovalUser = alias(user, "tempApprovalUser");

  const [row] = await db
    .select({
      groupId: groups.id,
      groupName: groups.groupName,
      mainApprovalUserId: mainApprovalUser.id,
      mainApprovalUserName: mainApprovalUser.name,
      mainApprovalUserEmail: mainApprovalUser.email,
      tempApprovalUserId: tempApprovalUser.id,
      tempApprovalUserName: tempApprovalUser.name,
      tempApprovalUserEmail: tempApprovalUser.email,
    })
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .leftJoin(
      mainApprovalUser,
      eq(groups.mainApprovalUser, mainApprovalUser.id)
    )
    .leftJoin(
      tempApprovalUser,
      eq(groups.tempApprovalUser, tempApprovalUser.id)
    );

  return row ?? undefined;
};
