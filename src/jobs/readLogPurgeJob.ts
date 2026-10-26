import { logger } from "../middleware/logger.js";
import { purgeReadLog } from "../services/directory/readLogServices.js";

/**
 * Removes Read log rows past their twelve months. Runs on the nightly tick
 * beside the other sweeps; safe to call at any time.
 */
export const runReadLogPurge = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const removed = await purgeReadLog(now);
    if (removed === 0) {
      logger.debug("Read log purge: nothing to remove");
      return;
    }
    logger.info("Read log purge removed old rows", { removed, durationMs: Date.now() - startedAt });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed purge is recoverable on the next tick.
    logger.error("Read log purge failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
