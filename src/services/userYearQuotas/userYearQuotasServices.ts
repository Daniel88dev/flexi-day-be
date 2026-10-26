import type {
  UserYearQuotasInsertType,
  UserYearQuotasType,
  UserYearQuotasUpdateType,
  UserYearQuotasUpsertType,
} from "./types.js";
import { db, type DbTransaction } from "../../db/db.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { isExternalWorkerIn } from "../employment/externalWorkers.js";

export const getUserYearGroupQuotas = async (
  relatedYear: string,
  groupId: string,
  userId: string | null,
  tx?: DbTransaction
): Promise<UserYearQuotasType[]> => {
  const base = [eq(userYearQuotas.relatedYear, relatedYear), eq(userYearQuotas.groupId, groupId)];
  const where = userId !== null ? and(...base, eq(userYearQuotas.userId, userId)) : and(...base);

  return (tx ?? db).select().from(userYearQuotas).where(where);
};

/**
 * Opens a member's allowance for the current year from the group's defaults;
 * called wherever a membership is created. On a re-join an existing allowance
 * for that year wins. An External worker's opens at zero.
 */
export const openQuotaFromGroupDefaults = async (
  record: {
    id: string;
    userId: string;
    groupId: string;
    relatedYear: string;
    vacationDays: number;
    homeOfficeDays: number;
    sickDays: number;
  },
  tx?: DbTransaction
): Promise<UserYearQuotasType | undefined> => {
  const values = (await isExternalWorkerIn(record.userId, record.groupId, tx))
    ? { ...record, vacationDays: 0, homeOfficeDays: 0, sickDays: 0 }
    : record;
  const [row] = await (tx ?? db)
    .insert(userYearQuotas)
    .values(values)
    .onConflictDoNothing({
      target: [userYearQuotas.userId, userYearQuotas.groupId, userYearQuotas.relatedYear],
    })
    .returning();
  return row;
};

export const insertUserYearQuotas = async (
  records: UserYearQuotasInsertType[]
): Promise<UserYearQuotasType[]> => {
  return db.insert(userYearQuotas).values(records).onConflictDoNothing().returning();
};

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

/** A member's quota rows for one year across the given groups; a group without one is absent. */
export const getUserYearQuotasForGroups = async (
  userId: string,
  groupIds: string[],
  relatedYear: string,
  tx?: DbTransaction
): Promise<UserYearQuotasType[]> => {
  if (groupIds.length === 0) return [];
  return (tx ?? db)
    .select()
    .from(userYearQuotas)
    .where(
      and(
        eq(userYearQuotas.userId, userId),
        eq(userYearQuotas.relatedYear, relatedYear),
        inArray(userYearQuotas.groupId, groupIds)
      )
    );
};

/**
 * Sets a member's allowance for one year, creating the row when the member
 * has no quota for that year yet. Admin quota edits are the only writer of
 * absolute values — `decreaseChangeForUserYearQuotas` applies deltas — so the
 * conflict target is the (user, group, year) uniqueness the table already
 * enforces.
 */
export const upsertUserYearQuota = async (
  data: UserYearQuotasUpsertType,
  tx?: DbTransaction
): Promise<UserYearQuotasType | undefined> => {
  const [row] = await (tx ?? db)
    .insert(userYearQuotas)
    .values(data)
    .onConflictDoUpdate({
      target: [userYearQuotas.userId, userYearQuotas.groupId, userYearQuotas.relatedYear],
      set: {
        vacationDays: data.vacationDays,
        homeOfficeDays: data.homeOfficeDays,
        sickDays: data.sickDays,
        carriedOverDays: data.carriedOverDays,
      },
    })
    .returning();

  return row;
};

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

/**
 * Sets a member's allowance to zero in each group from `year` on, creating the
 * year's row where it is missing so the group defaults stop applying. Earlier
 * years stay as they were.
 */
export const zeroQuotasFromYear = async (
  userId: string,
  groupIds: string[],
  year: number,
  tx: DbTransaction
): Promise<void> => {
  if (groupIds.length === 0) return;
  const zero = { vacationDays: 0, homeOfficeDays: 0, sickDays: 0, carriedOverDays: 0 };
  await tx
    .insert(userYearQuotas)
    .values(
      groupIds.map((groupId) => ({
        id: generateRandomUUID(),
        userId,
        groupId,
        relatedYear: year.toString(),
        ...zero,
      }))
    )
    .onConflictDoUpdate({
      target: [userYearQuotas.userId, userYearQuotas.groupId, userYearQuotas.relatedYear],
      // The phone's quota pull runs on updated_at.
      set: { ...zero, updatedAt: new Date() },
    });
  await tx
    .update(userYearQuotas)
    .set({ ...zero, updatedAt: new Date() })
    .where(
      and(
        eq(userYearQuotas.userId, userId),
        inArray(userYearQuotas.groupId, groupIds),
        sql`${userYearQuotas.relatedYear}::int > ${year}`
      )
    );
};
