import type { DateString } from "../../utils/dateFunc.js";

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const pad = (value: number): string => value.toString().padStart(2, "0");

/**
 * The day a birthday falls on in a half-open window shorter than a year, and
 * the age turned that day when the year is known. 29 February falls on 28
 * February in a non-leap year. Null when the window holds no such day, or when
 * the day comes before the person was born.
 */
export const birthdayOccurrence = (
  birthday: { month: number; day: number; year: number | null },
  range: { startDate: DateString; endDate: DateString }
): { date: DateString; age: number | null } | null => {
  const firstYear = Number(range.startDate.slice(0, 4));
  const lastYear = Number(range.endDate.slice(0, 4));

  for (let year = firstYear; year <= lastYear; year++) {
    const day =
      birthday.month === 2 && birthday.day === 29 && !isLeapYear(year) ? 28 : birthday.day;
    const date = `${year.toString()}-${pad(birthday.month)}-${pad(day)}`;
    if (date < range.startDate || date >= range.endDate) continue;

    const age = birthday.year === null ? null : year - birthday.year;
    if (age !== null && age < 0) return null;
    return { date, age };
  }
  return null;
};
