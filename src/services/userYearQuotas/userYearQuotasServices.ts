import type {
  UserYearQuotasInsertType,
  UserYearQuotasType,
  UserYearQuotasUpdateType,
} from "./types.js";
import { db } from "../../db/db.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { and, eq, sql } from "drizzle-orm";

/**
 * Retrieves user year group quotas based on the provided related year, group ID,
 * and optionally the user ID.
 *
 * @param {string} relatedYear - The related year for which the quotas are fetched.
 * @param {string} groupId - The identifier of the group to fetch quotas for.
 * @param {string | null} userId - The identifier of the user, or null to fetch quotas without filtering by user.
 * @returns {Promise<UserYearQuotasType[]>} A promise that resolves to an array of user year quotas.
 */
export const getUserYearGroupQuotas = async (
  relatedYear: string,
  groupId: string,
  userId: string | null
): Promise<UserYearQuotasType[]> => {
  const base = [
    eq(userYearQuotas.relatedYear, relatedYear),
    eq(userYearQuotas.groupId, groupId),
  ];
  const where =
    userId !== null
      ? and(...base, eq(userYearQuotas.userId, userId))
      : and(...base);

  return db.select().from(userYearQuotas).where(where);
};

/**
 * Asynchronously inserts user year quota records into the database.
 *
 * @param {UserYearQuotasInsertType[]} records - An array of user year quota records to be inserted.
 * @returns {Promise<UserYearQuotasType[]>} A promise resolving to an array of inserted user year quota records.
 *
 * The function inserts the provided `records` into the `userYearQuotas` table in the database.
 * If any record conflicts with existing entries (based on the table's unique constraints),
 * the conflicting entries will be ignored without interruption of the operation.
 */
export const insertUserYearQuotas = async (
  records: UserYearQuotasInsertType[]
): Promise<UserYearQuotasType[]> => {
  return db
    .insert(userYearQuotas)
    .values(records)
    .onConflictDoNothing()
    .returning();
};

/**
 * Updates the user year quotas by decreasing the values of vacation days and home office days
 * based on the provided changes. The update is performed for a specific user, group, and year.
 *
 * @param {UserYearQuotasUpdateType} data - An object containing the user ID, group ID, year,
 * and the values by which vacation days and home office days should be decreased.
 * @returns {Promise<UserYearQuotasType | undefined>} A promise that resolves to the updated
 * user year quotas object if successful, or undefined if no matching record is found.
 */
export const decreaseChangeForUserYearQuotas = async (
  data: UserYearQuotasUpdateType
): Promise<UserYearQuotasType | undefined> => {
  const [row] = await db
    .update(userYearQuotas)
    .set({
      vacationDays: sql`${userYearQuotas.vacationDays} - ${data.vacationChange}`,
      homeOfficeDays: sql`${userYearQuotas.homeOfficeDays} - ${data.homeOfficeChange}`,
    })
    .where(
      and(
        eq(userYearQuotas.userId, data.userId),
        eq(userYearQuotas.groupId, data.groupId),
        eq(userYearQuotas.relatedYear, data.relatedYear)
      )
    )
    .returning();

  return row;
};

/**
 * Updates the yearly quota of vacation days and home office days for a specific quota record identified by its ID.
 *
 * @param {string} id - The unique identifier of the user whose quotas are being updated.
 * @param {number} vacations - The updated number of vacation days for the user.
 * @param {number} homeOffice - The updated number of home office days for the user.
 * @returns {Promise<UserYearQuotasType | undefined>} A promise that resolves to the updated user year quotas if successful, or undefined if no matching record is found.
 */
export const updateUserYearQuotasById = async (
  id: string,
  vacations: number,
  homeOffice: number
): Promise<UserYearQuotasType | undefined> => {
  const [row] = await db
    .update(userYearQuotas)
    .set({
      vacationDays: vacations,
      homeOfficeDays: homeOffice,
    })
    .where(eq(userYearQuotas.id, id))
    .returning();

  return row;
};
