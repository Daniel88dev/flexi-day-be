/** `YYYY-MM-DD`. */
export type IsoDate = string;

export type RepeatFreq = "daily" | "weekly" | "monthly" | "yearly";
export type MonthlyMode = "day" | "weekday" | "lastWeekday";

/**
 * A recurring group event's rule as the API and every client carry it.
 * `weekdays` count 0 = Monday … 6 = Sunday, unlike `groups.workingDays`.
 */
export interface RepeatRule {
  freq: RepeatFreq;
  interval: number;
  /** Weekly only, always holds the start's weekday; empty otherwise. */
  weekdays: number[];
  /** Monthly only, read off the start date; null otherwise. */
  monthlyMode: MonthlyMode | null;
  /** Inclusive; null repeats forever. */
  until: IsoDate | null;
}

export interface OccurrenceSource {
  startDate: IsoDate;
  endDate: IsoDate;
  repeat: RepeatRule | null;
  skippedDates: IsoDate[];
}

/** One dated occurrence, both ends inclusive. */
export interface Occurrence {
  startDate: IsoDate;
  endDate: IsoDate;
}

const DAY_MS = 86_400_000;

const toUtc = (date: IsoDate): number => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
};

const fromUtc = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

export const plusDays = (date: IsoDate, days: number): IsoDate =>
  fromUtc(toUtc(date) + days * DAY_MS);

export const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((toUtc(to) - toUtc(from)) / DAY_MS);

/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (date: IsoDate): number => (new Date(toUtc(date)).getUTCDay() + 6) % 7;

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const ymd = (year: number, month: number, day: number): IsoDate =>
  fromUtc(Date.UTC(year, month - 1, day));

/** A day the month lacks lands on its last day. */
const clampDay = (year: number, month: number, day: number): IsoDate =>
  ymd(year, month, Math.min(day, daysInMonth(year, month)));

/** Which weekday of its month a date is: `nth` 1 to 5, and whether it is the last one. */
export const monthPosition = (date: IsoDate): { nth: number; isLast: boolean } => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { nth: Math.ceil(day / 7), isLast: day + 7 > daysInMonth(year, month) };
};

/** `nth` 1 to 4, or -1 for the last. */
const nthWeekday = (year: number, month: number, weekday: number, nth: number): IsoDate => {
  if (nth === -1) {
    const last = ymd(year, month, daysInMonth(year, month));
    return plusDays(last, -((weekdayOf(last) - weekday + 7) % 7));
  }
  const first = ymd(year, month, 1);
  return plusDays(first, ((weekday - weekdayOf(first) + 7) % 7) + (nth - 1) * 7);
};

const parts = (date: IsoDate) => date.split("-").map(Number) as [number, number, number];

/** The first period index at or before `target`, aligned to the interval. */
const alignedStart = (elapsed: number, interval: number): number =>
  Math.max(0, elapsed - (elapsed % interval));

const recurringDates = (
  startDate: IsoDate,
  rule: RepeatRule,
  lower: IsoDate,
  last: IsoDate
): IsoDate[] => {
  const out: IsoDate[] = [];
  const [startYear, startMonth, startDay] = parts(startDate);
  const [lowerYear, lowerMonth] = parts(lower);

  switch (rule.freq) {
    case "daily": {
      const elapsed = daysBetween(startDate, lower);
      const first = Math.ceil(Math.max(0, elapsed) / rule.interval) * rule.interval;
      for (
        let date = plusDays(startDate, first);
        date <= last;
        date = plusDays(date, rule.interval)
      )
        out.push(date);
      break;
    }
    case "weekly": {
      const monday = plusDays(startDate, -weekdayOf(startDate));
      const weekdays = [...rule.weekdays].sort((a, b) => a - b);
      const elapsed = Math.floor(daysBetween(monday, lower) / 7);
      for (let week = alignedStart(elapsed, rule.interval); ; week += rule.interval) {
        const weekStart = plusDays(monday, week * 7);
        if (weekStart > last) break;
        for (const weekday of weekdays) out.push(plusDays(weekStart, weekday));
      }
      break;
    }
    case "monthly": {
      const mode = rule.monthlyMode ?? "day";
      const { nth } = monthPosition(startDate);
      const position = mode === "lastWeekday" || nth === 5 ? -1 : nth;
      const weekday = weekdayOf(startDate);
      const elapsed = (lowerYear - startYear) * 12 + (lowerMonth - startMonth);
      for (let step = alignedStart(elapsed, rule.interval); ; step += rule.interval) {
        const index = startMonth - 1 + step;
        const year = startYear + Math.floor(index / 12);
        const month = (index % 12) + 1;
        if (ymd(year, month, 1) > last) break;
        out.push(
          mode === "day"
            ? clampDay(year, month, startDay)
            : nthWeekday(year, month, weekday, position)
        );
      }
      break;
    }
    case "yearly": {
      const elapsed = lowerYear - startYear;
      for (let step = alignedStart(elapsed, rule.interval); ; step += rule.interval) {
        const year = startYear + step;
        if (ymd(year, 1, 1) > last) break;
        out.push(clampDay(year, startMonth, startDay));
      }
      break;
    }
  }
  return out;
};

/**
 * The occurrences of a group event that touch the window `from`..`to`, both
 * inclusive, in date order. A one-off answers itself when any of its days is in
 * the window. A recurring group event applies its rule, with a day the month
 * lacks moved to its last day, then `until` and its skipped dates.
 */
export const occurrences = (source: OccurrenceSource, from: IsoDate, to: IsoDate): Occurrence[] => {
  const span = daysBetween(source.startDate, source.endDate);
  const rule = source.repeat;
  if (!rule) {
    return source.endDate >= from && source.startDate <= to
      ? [{ startDate: source.startDate, endDate: source.endDate }]
      : [];
  }

  const last = rule.until && rule.until < to ? rule.until : to;
  const reach = plusDays(from, -span);
  const lower = reach > source.startDate ? reach : source.startDate;
  if (lower > last) return [];

  const skipped = new Set(source.skippedDates);
  return recurringDates(source.startDate, rule, lower, last)
    .filter((date) => date >= lower && date <= last && !skipped.has(date))
    .map((date) => ({ startDate: date, endDate: plusDays(date, span) }));
};
