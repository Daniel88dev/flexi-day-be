import AppError from "./appError.js";

export type DateString = string;

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

// Returns true when the supplied UTC date is a working day (Mon-Fri).
export const isBusinessDay = (date: Date): boolean => {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
};

/**
 * Returns true when the given ISO date falls on one of the group's configured
 * working days. `workingDays` holds `Date.getUTCDay()` numbers (0=Sun … 6=Sat).
 */
export const isWorkingDay = (iso: DateString, workingDays: number[]): boolean => {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return workingDays.includes(date.getUTCDay());
};

/**
 * Keeps only the ISO dates that fall on a configured working day, preserving
 * order. Used so a vacation request books — and counts against quotas — only
 * on the group's working days.
 */
export const filterWorkingDays = (days: DateString[], workingDays: number[]): DateString[] =>
  days.filter((day) => isWorkingDay(day, workingDays));

/**
 * Counts the number of business days (Mon-Fri) between two inclusive ISO
 * dates. Returns 0 when end < start.
 */
export const countBusinessDaysInclusive = (from: DateString, to: DateString): number => {
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
export const expandDateRangeInclusive = (from: DateString, to: DateString): DateString[] => {
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
