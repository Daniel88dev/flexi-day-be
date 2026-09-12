import type { DbTransaction } from "../../db/db.js";
import { ensureBankHolidays } from "../bankHoliday/bankHolidayServices.js";
import { expandDateRangeInclusive, isWorkingDay, type DateString } from "../../utils/dateFunc.js";
import { NonWorkingDayCause, type NonWorkingDay, type WorkingDayRules } from "./types.js";

/**
 * The dates in a range nobody is expected at work on: the days of the week the
 * organization does not keep, and the public holidays of its country.
 *
 * Holidays resolve through the stored table and its lazy fill, so a year asked
 * for the first time is computed and kept rather than recomputed per request.
 * A holiday landing on a day nobody works stays a non-working day — the
 * calendar of the week is the coarser fact, and saying "holiday" for a Sunday
 * would be true and useless.
 */
export const getNonWorkingDays = async (
  rules: WorkingDayRules,
  from: DateString,
  to: DateString,
  tx?: DbTransaction
): Promise<Map<DateString, NonWorkingDay>> => {
  const dates = expandDateRangeInclusive(from, to);
  const nonWorking = new Map<DateString, NonWorkingDay>();

  for (const date of dates) {
    if (!isWorkingDay(date, rules.workingDays)) {
      nonWorking.set(date, { cause: NonWorkingDayCause.NonWorkingDay, name: null });
    }
  }

  const country = rules.holidayCountry;
  if (country === null || dates.length === 0) return nonWorking;

  const years = [...new Set(dates.map((date) => Number(date.slice(0, 4))))];
  const holidays = (
    await Promise.all(years.map((year) => ensureBankHolidays(year, country, undefined, tx)))
  ).flat();

  for (const holiday of holidays) {
    if (!nonWorking.has(holiday.date) && holiday.date >= from && holiday.date <= to) {
      nonWorking.set(holiday.date, { cause: NonWorkingDayCause.Holiday, name: holiday.name });
    }
  }

  return new Map([...nonWorking].sort(([left], [right]) => left.localeCompare(right)));
};
