import AppError from "./appError.js";

export type DateString = string;

/**
 * Converts a given Date object to a string in ISO 8601 date format (YYYY-MM-DD).
 *
 * @param {Date} date - The Date object to be converted. Must be a valid Date instance.
 * @returns {DateString} The ISO 8601 formatted date string (YYYY-MM-DD).
 * @throws {AppError} Throws an error if the provided Date object is invalid.
 */
export const formatDateToISOString = (date: Date): DateString => {
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      message: "Invalid date",
      logging: true,
      context: { input: String(date), inputType: typeof date },
    });
  }
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * Formats the start and end dates of a given month and year into ISO string representations.
 *
 * @param {number} year - The year for which the dates are to be formatted.
 * @param {number} month - The month (1-indexed, 1 for January, 12 for December) for which the dates are to be formatted.
 * @throws {AppError} Throws an error if the month is not between 1 and 12.
 * @returns {{ startDate: DateString, endDate: DateString }} An object containing the start date (first day of the month)
 * and end date (first day of the next month) in ISO string format.
 */
/**
 * Returns true when the supplied UTC date is a working day (Mon-Fri).
 */
export const isBusinessDay = (date: Date): boolean => {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
};

/**
 * Counts the number of business days (Mon-Fri) between two inclusive ISO
 * dates. Returns 0 when end < start.
 */
export const countBusinessDaysInclusive = (
  from: DateString,
  to: DateString
): number => {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end.getTime() < start.getTime()) return 0;

  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    if (isBusinessDay(cursor)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
};

/**
 * Expands an inclusive date range into the ordered list of ISO date strings
 * it contains.
 */
export const expandDateRangeInclusive = (
  from: DateString,
  to: DateString
): DateString[] => {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (end.getTime() < start.getTime()) return [];

  const out: DateString[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    out.push(formatDateToISOString(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
};

export const formatStartAndEndDate = (
  year: number,
  month: number
): { startDate: DateString; endDate: DateString } => {
  if (month < 1 || month > 12) {
    throw new AppError({
      message: "month must be between 1 and 12",
      logging: true,
      context: { month: month, year: year },
    });
  }
  if (!Number.isInteger(year)) {
    throw new AppError({
      message: "year must be an integer",
      logging: true,
      context: { month: month, year: year },
    });
  }
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1));

  return {
    startDate: formatDateToISOString(startDate),
    endDate: formatDateToISOString(endDate),
  };
};
