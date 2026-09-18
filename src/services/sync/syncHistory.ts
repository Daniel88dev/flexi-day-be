import type { SyncHistoryWindow } from "./types.js";

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
