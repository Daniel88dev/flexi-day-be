import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import type { VacationInsertType, VacationType } from "./types.js";

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
    isNull(vacation.deletedAt),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate),
  ] as const;
  const where = groupId
    ? and(...base, eq(vacation.groupId, groupId))
    : and(...base);
  return db.select().from(vacation).where(where);
};

/**
 * Handles the insertion of vacation data into the database.
 * If a conflict occurs during insertion (e.g., duplicate records),
 * no action is taken, and the function safely returns undefined.
 *
 * @param {VacationInsertType} record - The vacation data to be inserted into the database.
 * @returns {Promise<VacationType | undefined>} A promise resolving to the inserted vacation record
 * if successful, or undefined if no action was taken due to a conflict.
 */
export const postVacation = async (
  record: VacationInsertType
): Promise<VacationType | undefined> => {
  const [row] = await db
    .insert(vacation)
    .values(record)
    .onConflictDoNothing({
      target: [vacation.userId, vacation.requestedDay],
    })
    .returning();
  return row;
};

/**
 * Approves a vacation request by updating its approval details in the database.
 *
 * @param {string} vacationId - The unique identifier of the vacation request to be approved.
 * @param {string} approvingPerson - The identifier of the person approving the vacation request.
 * @returns {Promise<VacationType | undefined>} A promise resolving to the updated vacation object if the operation is successful, or undefined if no record was updated.
 */
export const approveVacation = async (
  vacationId: string,
  approvingPerson: string
): Promise<VacationType | undefined> => {
  const [row] = await db
    .update(vacation)
    .set({
      approvedBy: approvingPerson,
      approvedAt: new Date(),
      rejectedBy: null,
      rejectedAt: null,
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};

/**
 * Rejects a vacation request by updating the vacation record in the database.
 * The function sets the rejection timestamp, records the person who rejected the request,
 * and clears any prior approval or approver information.
 *
 * @param {string} vacationId - The unique identifier of the vacation request to be rejected.
 * @param {string} rejectingPerson - The name or identifier of the person rejecting the vacation request.
 * @returns {Promise<VacationType | undefined>} A promise that resolves to the updated vacation record if the operation is successful, or undefined if no record was updated.
 */
export const rejectVacation = async (
  vacationId: string,
  rejectingPerson: string
): Promise<VacationType | undefined> => {
  const [row] = await db
    .update(vacation)
    .set({
      rejectedAt: new Date(),
      rejectedBy: rejectingPerson,
      approvedAt: null,
      approvedBy: null,
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};

/**
 * Asynchronously deletes a vacation record by marking it as deleted in the database.
 *
 * This function updates the vacation record in the database by setting its `deletedAt` field
 * to the current date, effectively marking it as deleted. Once updated, it returns the
 * modified vacation record. If no record matches the provided vacation ID, the function
 * returns `undefined`.
 *
 * @param {string} vacationId - The unique identifier of the vacation record to be deleted.
 * @returns {Promise<VacationType | undefined>} A promise that resolves to the updated vacation record
 *                                              if a matching record is found, or `undefined` if no matching
 *                                              record exists.
 */
export const deleteVacation = async (
  vacationId: string
): Promise<VacationType | undefined> => {
  const [row] = await db
    .update(vacation)
    .set({
      deletedAt: new Date(),
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};
