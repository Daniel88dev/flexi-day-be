import type { VacationInsertType, VacationType } from "./types.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";

export const postVacation = async (
  record: VacationInsertType
): Promise<VacationType | undefined> => {
  const [row] = await db.insert(vacation).values(record).returning();
  return row;
};
