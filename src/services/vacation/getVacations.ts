import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { and, eq, gte, lt } from "drizzle-orm";
import type { VacationType } from "./types.js";

export const getVacations = async (
  userId: string,
  startDate: string,
  endDate: string,
  groupId: string | null = null
): Promise<VacationType[]> => {
  return db
    .select()
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, userId),
        eq(vacation.groupId, groupId ?? "*"),
        gte(vacation.requestedDay, startDate),
        lt(vacation.requestedDay, endDate)
      )
    );
};
