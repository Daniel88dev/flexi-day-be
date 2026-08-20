import { db, type DbTransaction } from "../../db/db.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { BankHolidayInsertType, BankHolidayType } from "./types.js";

/**
 * Lists bank holidays for the given country (and optional region) in a single
 * calendar year, ordered by date.
 */
export const listBankHolidays = async (
  year: number,
  country: string,
  region?: string
): Promise<BankHolidayType[]> => {
  const yearStart = `${year.toString().padStart(4, "0")}-01-01`;
  const yearEnd = `${(year + 1).toString().padStart(4, "0")}-01-01`;

  const filters = [
    eq(bankHolidays.country, country),
    gte(bankHolidays.date, yearStart),
    lt(bankHolidays.date, yearEnd),
  ];
  if (region) {
    filters.push(eq(bankHolidays.region, region));
  }

  return db
    .select()
    .from(bankHolidays)
    .where(and(...filters))
    .orderBy(asc(bankHolidays.date));
};

/**
 * Inserts bank holiday rows, ignoring any that already exist. Conflict-free by
 * the `(country, region, date)` unique index, so concurrent first-time fills
 * for the same country and year are safe.
 */
export const insertBankHolidays = async (
  rows: BankHolidayInsertType[],
  tx?: DbTransaction
): Promise<void> => {
  if (rows.length === 0) return;
  await (tx ?? db).insert(bankHolidays).values(rows).onConflictDoNothing();
};
