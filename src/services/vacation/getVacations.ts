import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { and, eq, gte, lt } from "drizzle-orm";
import type { VacationType } from "./types.js";

/**
 * Retrieves a list of vacations for a specified user within a given date range.
 *
 * @param {string} userId - The identifier of the user whose vacations are to be retrieved.
 * @param {string} startDate - The start date of the vacation range in the format 'YYYY-MM-DD'.
 * @param {string} endDate - The end date of the vacation range in the format 'YYYY-MM-DD'.
 * @param {string | null} [groupId=null] - Optional group ID to filter vacations by group. If null, group filtering is not applied.
 * @returns {Promise<VacationType[]>} A promise resolving to an array of vacations matching the specified criteria.
 */
export const getVacations = async (
  userId: string,
  startDate: string,
  endDate: string,
  groupId: string | null = null
): Promise<VacationType[]> => {
  const base = [
    eq(vacation.userId, userId),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate),
  ] as const;
  const where = groupId
    ? and(...base, eq(vacation.groupId, groupId))
    : and(...base);
  return db.select().from(vacation).where(where);
};
