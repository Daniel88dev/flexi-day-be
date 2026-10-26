import { logger } from "../middleware/logger.js";
import { purgeRetention } from "../services/directory/retentionPurge.js";

/**
 * Empties the Profile Sections past their organization's Retention period.
 * Runs on the nightly tick beside the other sweeps; safe to call at any time.
 */
export const runRetentionPurge = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const purged = await purgeRetention(now);
    if (purged === 0) {
      logger.debug("Retention purge: nothing to remove");
      return;
    }
    logger.info("Retention purge emptied Sections", { purged, durationMs: Date.now() - startedAt });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed purge is recoverable on the next tick.
    logger.error("Retention purge failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
