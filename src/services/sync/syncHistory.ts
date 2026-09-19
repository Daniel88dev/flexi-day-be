import type { SyncBankHolidayWindow, SyncHistoryWindow } from "./types.js";

/**
 * How far back a pull reaches for rows that are dated rather than merely
 * changed. Read in UTC so the boundary does not depend on the server's zone,
 * and derived from the cursor time, so every page of one loop covers the same
 * span.
 */
export const syncHistoryWindow = (now: Date): SyncHistoryWindow => {
  const year = (now.getUTCFullYear() - 1).toString();
  return { firstDay: `${year}-01-01`, firstYear: year };
};

/** Whether two pulls reach back to the same first day. */
export const sameHistoryWindow = (a: Date, b: Date): boolean =>
  syncHistoryWindow(a).firstDay === syncHistoryWindow(b).firstDay;

/**
 * The calendar span a pull's bank holidays cover: the previous, current and
 * next year of the cursor time, read in UTC like the history window and
 * derived from the same position, so every page of one loop reads the same
 * three years.
 */
export const syncBankHolidayWindow = (now: Date): SyncBankHolidayWindow => {
  const current = now.getUTCFullYear();
  return {
    years: [current - 1, current, current + 1],
    firstDay: `${(current - 1).toString()}-01-01`,
    lastDay: `${(current + 1).toString()}-12-31`,
  };
};
