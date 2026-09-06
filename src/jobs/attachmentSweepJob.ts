import { logger } from "../middleware/logger.js";
import { sweepAttachments } from "../services/attachment/attachmentRetention.js";

/**
 * Removes attachments past retention, on Requests with no live day, and
 * uploads that never finished. Runs on the nightly tick after the quota
 * rollover; safe to call at any time.
 */
export const runAttachmentSweep = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await sweepAttachments(now);

    if (result.expired + result.noLiveDay + result.stale === 0) {
      logger.debug("Attachment sweep: nothing to remove");
      return;
    }

    logger.info("Attachment sweep removed attachments", {
      ...result,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed sweep is recoverable on the next tick.
    logger.error("Attachment sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
