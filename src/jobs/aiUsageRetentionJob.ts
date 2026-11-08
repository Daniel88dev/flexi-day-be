import { logger } from "../middleware/logger.js";
import { retainAiUsage } from "../services/aiFeatures/aiUsageRetention.js";

/**
 * Rolls finished weeks of AI usage into weekly totals and deletes what is past
 * its retention. Runs on the nightly tick beside the other sweeps; safe to
 * call at any time.
 */
export const runAiUsageRetention = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const { skipped, ...counts } = await retainAiUsage(now);
    if (skipped) {
      logger.info("AI usage retention already running elsewhere, skipping");
      return;
    }
    if (Object.values(counts).every((count) => count === 0)) {
      logger.debug("AI usage retention: nothing to roll or remove");
      return;
    }
    logger.info("AI usage retention ran", { ...counts, durationMs: Date.now() - startedAt });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed run is recoverable on the next tick.
    logger.error("AI usage retention failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
