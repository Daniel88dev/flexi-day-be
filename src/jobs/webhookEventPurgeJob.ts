import { logger } from "../middleware/logger.js";
import { purgeWebhookEvents } from "../services/assistant/webhookServices.js";

/**
 * Forgets Anthropic webhook deliveries handled more than a week ago. Runs on
 * the nightly tick beside the other sweeps; safe to call at any time.
 */
export const runWebhookEventPurge = async (now = new Date()): Promise<void> => {
  try {
    const deleted = await purgeWebhookEvents(now);
    if (deleted === 0) {
      logger.debug("Webhook event purge: nothing to remove");
      return;
    }
    logger.info("Webhook event purge removed handled deliveries", { deleted });
  } catch (error) {
    // Never rethrow: a failed purge is recoverable on the next tick.
    logger.error("Webhook event purge failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
