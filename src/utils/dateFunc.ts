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

// UTC everywhere, so opening a quota and validating a booking against it
// cannot disagree about the year on a server that is not on UTC.
export const currentYear = (): number => new Date().getUTCFullYear();

// Returns true when the supplied UTC date is a working day (Mon-Fri).
export const isBusinessDay = (date: Date): boolean => {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
};

// True when the ISO date is one of `workingDays` (JS `Date.getUTCDay()` numbers, 0=Sun … 6=Sat).
export const isWorkingDay = (iso: DateString, workingDays: number[]): boolean => {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return workingDays.includes(date.getUTCDay());
};

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

/**
 * The UTC calendar date a whole number of months before `instant` — the cutoff
 * both retention sweeps measure against. Day-of-month overflow rolls forward
 * the way `Date` does, so 29 February a year on reads as 1 March.
 */
export const monthsAgoDay = (instant: Date, months: number): DateString => {
  const cutoff = new Date(instant);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString().slice(0, 10);
};

/**
 * The calendar day before a business date. Stepping the date itself rather than
 * subtracting a day of real time from the instant: on the morning after a
 * spring-forward the short day makes `now - 24 h` land two days back, which
 * would drop the day in between out of whatever range was being built.
 */
export const previousDay = (date: DateString): DateString => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
};

/**
 * The calendar date an instant falls on in an IANA zone — what fixes a
 * session's `businessDate` at clock-in. `en-CA` is the only widely available
 * locale whose numeric format is already ISO, but its parts are read
 * explicitly rather than trusting that, because a runtime with a different CLDR
 * would otherwise silently shift every business date by a formatting quirk.
 */
export const businessDateInZone = (instant: Date, timeZone: string): DateString => {
  if (Number.isNaN(instant.getTime())) {
    throw new AppError({
      message: "Invalid date",
      logging: true,
      context: { input: String(instant), timeZone },
    });
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
};

/**
 * The first and last calendar dates of a month. `formatStartAndEndDate` returns
 * the first of the *next* month as its end, which is what a half-open range
 * wants and what an inclusive one must not have.
 */
export const monthStart = (year: number, month: number): DateString =>
  formatDateToISOString(new Date(Date.UTC(year, month - 1, 1)));

export const monthEnd = (year: number, month: number): DateString =>
  formatDateToISOString(new Date(Date.UTC(year, month, 0)));
