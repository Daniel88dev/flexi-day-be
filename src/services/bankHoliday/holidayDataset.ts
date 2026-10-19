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

const HOUR_MS = 60 * 60 * 1000;

const holidaysOf = (country: string): Holidays => {
  let hd = instances.get(country);
  if (!hd) {
    // No language override on purpose: holiday names stay in the country's own
    // language ("Nový rok", not "New Year's Day") — that is what the people in
    // that country call the day. Only the country picker is English.
    hd = new Holidays(country);
    instances.set(country, hd);
  }
  return hd;
};

const addDays = (date: string, days: number): string => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

// The whole days a holiday spans. One extra hour absorbs a DST night (23 or 25
// hours), and flooring drops a trailing part-day: TR's PT90H bayram, which
// starts the evening before, covers three days, not four.
const coveredDayCount = (start: Date, end: Date): number => {
  const hours = Math.round((end.getTime() - start.getTime()) / HOUR_MS);
  return Math.max(1, Math.floor((hours + 1) / 24));
};

type HolidayDay = { date: string; name: string };

// Every holiday read recomputes, so the days are kept per country-year. The
// clear bounds it: any signed-in caller can ask for any year from 1970 to 2100.
const HOLIDAY_DAYS_CACHE_LIMIT = 1000;
const holidayDaysCache = new Map<string, HolidayDay[]>();

const computeHolidayDays = (country: string, year: number): HolidayDay[] => {
  const key = `${country}:${year.toString()}`;
  const cached = holidayDaysCache.get(key);
  if (cached) return cached;

  const hd = holidaysOf(country);
  const yearPrefix = `${year.toString().padStart(4, "0")}-`;
  const byDate = new Map<string, string>();
  // The previous year's list is read for the tail of a holiday that began in it.
  for (const holiday of [...hd.getHolidays(year - 1), ...hd.getHolidays(year)]) {
    if (holiday.type !== "public") continue;
    // `date` is a local "YYYY-MM-DD HH:mm:ss" string; slicing it avoids the
    // timezone shifts a Date round-trip would introduce.
    const first = holiday.date.slice(0, 10);
    const count = coveredDayCount(holiday.start, holiday.end);
    for (let offset = 0; offset < count; offset++) {
      const date = addDays(first, offset);
      if (date.startsWith(yearPrefix) && !byDate.has(date)) byDate.set(date, holiday.name);
    }
  }

  const days = [...byDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, name]) => ({ date, name }));
  if (holidayDaysCache.size >= HOLIDAY_DAYS_CACHE_LIMIT) holidayDaysCache.clear();
  holidayDaysCache.set(key, days);
  return days;
};

/**
 * Computes the public holidays of a country for one calendar year: one row per
 * day a public holiday covers, so a three-day holiday yields three rows. Rows
 * stay inside the year. An unsupported country code yields an empty array
 * rather than throwing.
 */
export const computePublicHolidays = (country: string, year: number): BankHolidayInsertType[] => {
  if (!isSupportedCountry(country)) {
    return [];
  }

  return computeHolidayDays(country, year).map(({ date, name }) => ({
    id: generateRandomUUID(),
    date,
    name,
    country,
  }));
};
