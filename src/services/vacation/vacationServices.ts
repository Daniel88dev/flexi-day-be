import { db, type DbTransaction } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import type { VacationInsertType, VacationType } from "./types.js";

/**
 * Retrieves a list of vacations for a specific group within a given date range.
 * Optionally filters the vacations by a specific user.
 *
 * @param {string} groupId - The unique identifier of the group.
 * @param {string} startDate - The start date of the vacation range (inclusive) in ISO 8601 format.
 * @param {string} endDate - The end date of the vacation range (exclusive) in ISO 8601 format.
 * @param {string|null} [userId=null] - The unique identifier of the user to filter the vacations for.
 *                                       If null, retrieves vacations for all users in the group.
 * @returns {Promise<VacationType[]>} - A promise that resolves to an array of vacation objects that match the criteria.
 */
export const getVacationsForGroup = async (
  groupId: string,
  startDate: string,
  endDate: string,
  userId: string | null = null
): Promise<VacationType[]> => {
  const base = [
    eq(vacation.groupId, groupId),
    isNull(vacation.deletedAt),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate),
  ] as const;
  const where =
    userId !== null ? and(...base, eq(vacation.userId, userId)) : and(...base);
  return db.select().from(vacation).where(where);
};

/**
 * Retrieves a list of vacations for a specific user within a specified date range.
 *
 * @param {string} userId - The unique identifier of the user.
 * @param {string} startDate - The starting date of the range (inclusive) in ISO format.
 * @param {string} endDate - The ending date of the range (exclusive) in ISO format.
 * @returns {Promise<VacationType[]>} A promise that resolves to an array of vacation records.
 */
export const getVacationsForUser = async (
  userId: string,
  startDate: string,
  endDate: string
): Promise<VacationType[]> => {
  const base = [
    eq(vacation.userId, userId),
    isNull(vacation.deletedAt),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate),
  ] as const;
  const where = and(...base);
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
 * @param tx - Optional database transaction to use for the operation.
 * @returns {Promise<VacationType | undefined>} A promise resolving to the updated vacation object if the operation is successful, or undefined if no record was updated.
 */
export const approveVacation = async (
  vacationId: string,
  approvingPerson: string,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
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

/**
 * Retrieves a vacation record by its unique identifier.
 *
 * This asynchronous function fetches a vacation entry from the database
 * that matches the specified vacation ID and has not been marked as deleted.
 *
 * @param {string} vacationId - The unique identifier of the vacation to retrieve.
 * @param tx - Optional database transaction to use for the operation.
 * @returns {Promise<VacationType | undefined>} A promise that resolves to the vacation object if found, or undefined if not found or deleted.
 */
export const getVacationById = async (
  vacationId: string,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(vacation)
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)));

  return row;
};
