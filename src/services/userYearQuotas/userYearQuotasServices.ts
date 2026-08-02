import type {
  UserYearQuotasInsertType,
  UserYearQuotasType,
  UserYearQuotasUpdateType,
  UserYearQuotasUpsertType,
} from "./types.js";
import { db, type DbTransaction } from "../../db/db.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";

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
 * Opens a member's allowance for the current year from the group's defaults.
 *
 * Called whenever a membership is created — this is what the group's "default
 * vacation / home office days" actually mean, and what the Quotas tab promises
 * ("applies to members who have no allowance set for a year"). Without it a new
 * member's allowance is zero until an admin sets one by hand, so every number
 * the product shows them is wrong from the moment they join.
 *
 * `onConflictDoNothing` keeps it safe on a re-join: an existing allowance for
 * that year, however it was set, wins.
 */
export const openQuotaFromGroupDefaults = async (
  record: {
    id: string;
    userId: string;
    groupId: string;
    relatedYear: string;
    vacationDays: number;
    homeOfficeDays: number;
  },
  tx?: DbTransaction
): Promise<UserYearQuotasType | undefined> => {
  const [row] = await (tx ?? db)
    .insert(userYearQuotas)
    .values(record)
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

/**
 * Sums quota allocations for the supplied user across the supplied groups for
 * a given year. Returns zeros when no quota rows exist yet.
 */
export const sumUserQuotasForYear = async (
  userId: string,
  groupIds: string[],
  relatedYear: string
): Promise<{ vacationDays: number; homeOfficeDays: number; carriedOverDays: number }> => {
  if (groupIds.length === 0) {
    return { vacationDays: 0, homeOfficeDays: 0, carriedOverDays: 0 };
  }
  const [row] = await db
    .select({
      vacationDays: sql<number>`COALESCE(SUM(${userYearQuotas.vacationDays}), 0)`,
      homeOfficeDays: sql<number>`COALESCE(SUM(${userYearQuotas.homeOfficeDays}), 0)`,
      carriedOverDays: sql<number>`COALESCE(SUM(${userYearQuotas.carriedOverDays}), 0)`,
    })
    .from(userYearQuotas)
    .where(
      and(
        eq(userYearQuotas.userId, userId),
        eq(userYearQuotas.relatedYear, relatedYear),
        inArray(userYearQuotas.groupId, groupIds)
      )
    );
  return {
    vacationDays: Number(row?.vacationDays ?? 0),
    homeOfficeDays: Number(row?.homeOfficeDays ?? 0),
    carriedOverDays: Number(row?.carriedOverDays ?? 0),
  };
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
