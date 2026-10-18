import type { BirthdayFeedRecord } from "./types.js";

/** One Graph series a birthday goes out as; `segment` numbers it when there are several. */
export type GraphBirthdaySeries = {
  segment: number | null;
  startDate: string;
  interval: number;
  month: number;
  dayOfMonth: number;
};

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Four `interval: 4` series, one per year of a leap cycle: 29 February in the
 * leap year, 28 February in the other three. For a Graph that drops or moves
 * an `absoluteYearly` 29 February in non-leap years.
 */
export const leapDayFallbackSeries = (record: BirthdayFeedRecord): GraphBirthdaySeries[] => {
  const first = Number(record.startDate.slice(0, 4));
  return [0, 1, 2, 3].map((segment) => {
    const year = first + segment;
    const dayOfMonth = isLeapYear(year) ? 29 : 28;
    return {
      segment,
      startDate: `${year.toString()}-02-${dayOfMonth.toString()}`,
      interval: 4,
      month: 2,
      dayOfMonth,
    };
  });
};

/**
 * The series a birthday goes to Graph as. The T-348 probe has not run, so 29
 * February goes out as one series on day 29, trusting Graph to land it on 28
 * February in other years. Should the probe fail, return
 * `leapDayFallbackSeries(record)` for 29 February here; nothing else changes.
 */
export const graphBirthdaySeries = (record: BirthdayFeedRecord): GraphBirthdaySeries[] => [
  {
    segment: null,
    startDate: record.startDate,
    interval: 1,
    month: record.month,
    dayOfMonth: record.day,
  },
];
