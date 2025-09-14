import type { VacationInsertType, VacationType } from "./types.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";

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
    .onConflictDoNothing()
    .returning();
  return row;
};
