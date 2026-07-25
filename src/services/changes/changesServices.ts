import type { ChangeInsertType, ChangeRecordType } from "./types.js";
import { db, type DbTransaction } from "../../db/db.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { and, asc, eq, gte, lt } from "drizzle-orm";

// Date range is [startDate, endDate); a null userId returns the whole group.
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
  const where = userId ? and(...base, eq(changesSchema.userId, userId)) : and(...base);
  return db.select().from(changesSchema).where(where).orderBy(asc(changesSchema.createdAt));
};

export const postChanges = async (
  record: ChangeInsertType,
  tx?: DbTransaction
): Promise<ChangeRecordType | undefined> => {
  const [row] = await (tx ?? db).insert(changesSchema).values(record).returning();

  return row;
};
