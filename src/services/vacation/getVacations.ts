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
