import type { GroupInsertType, GroupType } from "./types.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

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
    .where(and(eq(groups.id, groupId), isNotNull(groups.deletedAt)));

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
    .where(and(inArray(groups.id, groupIds), isNotNull(groups.deletedAt)));
};

/**
 * Asynchronously creates a new group record in the database.
 *
 * @param {GroupInsertType} data - The data to insert as the new group record.
 * @returns {Promise<GroupType | undefined>} A promise that resolves to the newly created group record or undefined if no record is returned.
 */
export const createGroup = async (
  data: GroupInsertType
): Promise<GroupType | undefined> => {
  const [row] = await db.insert(groups).values(data).returning();
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
    .where(eq(groups.id, groupId))
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
    .where(eq(groups.id, groupId))
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
    .where(eq(groups.id, groupId))
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
    .where(eq(groups.id, groupId))
    .returning();

  return row;
};
