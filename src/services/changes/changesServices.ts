import type { ChangeInsertType, ChangeRecordType } from "./types.js";
import { db } from "../../db/db.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { and, asc, eq, gte, lt } from "drizzle-orm";

/**
 * Retrieves the changes for a specific group and user within a given date range.
 *
 * @param {string} groupId - The ID of the group for which changes are to be fetched.
 * @param {string} startDate - The inclusive start of the range.
 * @param {string} endDate - The exclusive end of the range.
 * @param {string|null} [userId=null] - The ID of the user for whom changes are filtered. If null, changes for all users in the group are returned.
 * @returns {Promise<ChangeRecordType[]>} A Promise that resolves to an array of change records matching the specified criteria.
 */
export const getChangesForUser = async (
  groupId: string,
  startDate: Date,
  endDate: Date,
  userId: string | null = null
): Promise<ChangeRecordType[]> => {
  const base = [
    eq(changesSchema.groupId, groupId),
    gte(changesSchema.createdAt, startDate),
    lt(changesSchema.createdAt, endDate),
  ] as const;
  const where = userId
    ? and(...base, eq(changesSchema.userId, userId))
    : and(...base);
  return db
    .select()
    .from(changesSchema)
    .where(where)
    .orderBy(asc(changesSchema.createdAt));
};

/**
 * Asynchronously posts changes to the database by inserting a new record into the changes schema.
 * Returns the newly inserted record. Throws on database errors.
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
