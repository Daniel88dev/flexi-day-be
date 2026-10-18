import type { SyncCapabilities } from "./types.js";

export const SYNC_ACCEPTS_HEADER = "x-client-sync-accepts";

const AWAY_TOKEN = "away";

/**
 * Builds without the token store only the nine stored record types and fail a
 * whole page on `AWAY`, so a missing or unreadable header means it is refused.
 */
export const readSyncCapabilities = (header: string | undefined): SyncCapabilities => ({
  acceptsAway: (header ?? "").split(",").some((token) => token.trim().toLowerCase() === AWAY_TOKEN),
});
