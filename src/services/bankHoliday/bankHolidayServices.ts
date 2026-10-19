import { db, type DbTransaction } from "../../db/db.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { computePublicHolidays, isSupportedCountry } from "./holidayDataset.js";
import type { BankHolidayInsertType, BankHolidayType } from "./types.js";

/**
 * Lists bank holidays for the given country (and optional region) in a single
 * calendar year, ordered by date.
 */
export const listBankHolidays = async (
  year: number,
  country: string,
  region?: string,
  tx?: DbTransaction
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

  return (tx ?? db)
    .select()
    .from(bankHolidays)
    .where(and(...filters))
    .orderBy(asc(bankHolidays.date));
};

/**
 * Inserts bank holiday rows, ignoring any that already exist. Concurrent
 * first-time fills are safe because of the partial unique index on
 * `(country, date) WHERE region IS NULL` — the `(country, region, date)`
 * index alone never fires for the NULL-region rows the dataset writes.
 */
export const insertBankHolidays = async (
  rows: BankHolidayInsertType[],
  tx?: DbTransaction
): Promise<void> => {
  if (rows.length === 0) return;
  await (tx ?? db).insert(bankHolidays).values(rows).onConflictDoNothing();
};

/**
 * The holidays of one country and year, computing and storing them the first
 * time either is asked for. The table starts empty and fills per pair;
 * unsupported countries simply stay empty.
 *
 * Every read also inserts any computed day the stored set lacks. It never
 * deletes or rewrites a row: the sync pull has no tombstones for bank
 * holidays, and a stored row's id must stay stable.
 *
 * A region-filtered read never fills. The dataset rows carry no region, so a
 * fill there would duplicate an already-cached country rather than satisfy
 * the query.
 */
export const ensureBankHolidays = async (
  year: number,
  country: string,
  region?: string,
  tx?: DbTransaction
): Promise<BankHolidayType[]> => {
  const stored = await listBankHolidays(year, country, region, tx);
  if (region || !isSupportedCountry(country)) return stored;

  const storedDates = new Set(stored.filter((row) => row.region === null).map((row) => row.date));
  const missing = computePublicHolidays(country, year).filter((row) => !storedDates.has(row.date));
  if (missing.length === 0) return stored;

  await insertBankHolidays(missing, tx);
  return listBankHolidays(year, country, region, tx);
};
