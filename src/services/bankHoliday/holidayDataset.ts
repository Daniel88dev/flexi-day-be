import Holidays from "date-holidays";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import type { BankHolidayInsertType } from "./types.js";

export type HolidayCountry = {
  code: string;
  name: string;
};

// Holidays instances parse the full country ruleset on construction, so both
// the country list and per-country instances are memoized for the process.
const instances = new Map<string, Holidays>();

let countriesCache: HolidayCountry[] | undefined;
let countryCodesCache: Set<string> | undefined;

const loadCountries = (): HolidayCountry[] => {
  if (!countriesCache) {
    const raw = new Holidays().getCountries("en");
    countriesCache = Object.entries(raw)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    countryCodesCache = new Set(countriesCache.map((c) => c.code));
  }
  return countriesCache;
};

export const getSupportedCountries = (): HolidayCountry[] => loadCountries();

export const isSupportedCountry = (code: string): boolean => {
  loadCountries();
  return countryCodesCache!.has(code);
};

/**
 * Computes the public holidays of a country for one calendar year. Returns
 * rows ready for insertion into `bank_holidays`; an unsupported country code
 * yields an empty array rather than throwing.
 */
export const computePublicHolidays = (country: string, year: number): BankHolidayInsertType[] => {
  if (!isSupportedCountry(country)) {
    return [];
  }

  let hd = instances.get(country);
  if (!hd) {
    // No language override on purpose: holiday names stay in the country's own
    // language ("Nový rok", not "New Year's Day") — that is what the people in
    // that country call the day. Only the country picker is English.
    hd = new Holidays(country);
    instances.set(country, hd);
  }

  const seen = new Set<string>();
  const rows: BankHolidayInsertType[] = [];
  for (const holiday of hd.getHolidays(year)) {
    if (holiday.type !== "public") continue;
    // `date` is a local "YYYY-MM-DD HH:mm:ss" string; slicing it avoids the
    // timezone shifts a Date round-trip would introduce.
    const date = holiday.date.slice(0, 10);
    if (seen.has(date)) continue;
    seen.add(date);
    rows.push({ id: generateRandomUUID(), date, name: holiday.name, country });
  }
  return rows;
};
