import { and, asc, eq, exists, inArray, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import type { BirthdayRecord, PutBirthdayBody } from "./types.js";

/** The user's row, a removed birthday's tombstone included. */
export const getBirthday = async (
  userId: string,
  tx?: DbTransaction
): Promise<BirthdayRecord | null> => {
  const [row] = await (tx ?? db)
    .select()
    .from(userBirthdays)
    .where(eq(userBirthdays.userId, userId))
    .limit(1);
  return row ?? null;
};

/** Writes the whole birthday, bringing a removed one back. */
export const saveBirthday = async (
  userId: string,
  body: PutBirthdayBody,
  tx?: DbTransaction
): Promise<BirthdayRecord> => {
  const values = { month: body.month, day: body.day, year: body.year, shared: body.shared };
  const [row] = await (tx ?? db)
    .insert(userBirthdays)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: userBirthdays.userId,
      set: { ...values, deletedAt: null, updatedAt: new Date() },
    })
    .returning();
  return row!;
};

/**
 * Wipes the birthday and leaves the row as a tombstone for the sync pull.
 * Answers false when there was no live birthday to remove.
 */
export const removeBirthday = async (userId: string, tx?: DbTransaction): Promise<boolean> => {
  const rows = await (tx ?? db)
    .update(userBirthdays)
    .set({ month: null, day: null, year: null, shared: false, deletedAt: new Date() })
    .where(and(eq(userBirthdays.userId, userId), isNull(userBirthdays.deletedAt)))
    .returning({ userId: userBirthdays.userId });
  return rows.length > 0;
};

/**
 * Live birthdays, shared or not, of everyone holding a live membership in one
 * of the groups. One row per user however many of the groups they are in.
 */
export const getMemberBirthdaysInGroups = async (
  groupIds: string[],
  tx?: DbTransaction
): Promise<BirthdayRecord[]> => {
  if (groupIds.length === 0) return [];
  const conn = tx ?? db;
  return conn
    .select()
    .from(userBirthdays)
    .where(
      and(
        isNull(userBirthdays.deletedAt),
        exists(
          conn
            .select({ one: groupUsers.id })
            .from(groupUsers)
            .where(
              and(
                eq(groupUsers.userId, userBirthdays.userId),
                inArray(groupUsers.groupId, groupIds),
                isNull(groupUsers.deletedAt)
              )
            )
        )
      )
    )
    .orderBy(asc(userBirthdays.userId));
};
