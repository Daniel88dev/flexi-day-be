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
      context: { input: String(date) },
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
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1));

  return {
    startDate: formatDateToISOString(startDate),
    endDate: formatDateToISOString(endDate),
  };
};
