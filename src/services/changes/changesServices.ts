import type { ChangeInsertType, ChangeRecordType } from "./types.js";
import { db } from "../../db/db.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { and, eq, gte, lt } from "drizzle-orm";

/**
 * Retrieves the changes for a specific group and user within a given date range.
 *
 * @param {string} groupId - The ID of the group for which changes are to be fetched.
 * @param {string} startDate - The start date of the range in ISO 8601 format.
 * @param {string} endDate - The end date of the range in ISO 8601 format.
 * @param {string|null} [userId=null] - The ID of the user for whom changes are filtered. If null, changes for all users in the group are returned.
 * @returns {Promise<ChangeRecordType[]>} A Promise that resolves to an array of change records matching the specified criteria.
 */
export const getChangesForUser = async (
  groupId: string,
  startDate: string,
  endDate: string,
  userId: string | null = null
): Promise<ChangeRecordType[]> => {
  const base = [
    eq(changesSchema.groupId, groupId),
    gte(changesSchema.createdAt, new Date(startDate)),
    lt(changesSchema.createdAt, new Date(endDate)),
  ] as const;
  const where = userId
    ? and(...base, eq(changesSchema.userId, userId))
    : and(...base);
  return db.select().from(changesSchema).where(where);
};

/**
 * Asynchronously posts changes to the database by inserting a new record into the changes schema.
 * Returns the newly inserted record or undefined if the operation fails.
 *
 * @param {ChangeInsertType} record - The record to be inserted into the database.
 * @returns {Promise<ChangeRecordType | undefined>} A promise that resolves to the inserted record or undefined.
 */
export const postChanges = async (
  record: ChangeInsertType
): Promise<ChangeRecordType | undefined> => {
  const [row] = await db.insert(changesSchema).values(record).returning();

  return row;
};
