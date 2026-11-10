import { logger } from "../middleware/logger.js";
import { retainAssistantChats } from "../services/assistant/chatLifecycle.js";

/**
 * Deletes Assistant sessions 30 days after their chat's last message and
 * chats 180 days after it, then retries every session delete still queued.
 * Runs on the nightly tick; safe to call at any time.
 */
export const runAssistantChatRetention = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const counts = await retainAssistantChats(now);
    if (Object.values(counts).every((count) => count === 0)) {
      logger.debug("Assistant chat retention: nothing to close or remove");
      return;
    }
    logger.info("Assistant chat retention ran", { ...counts, durationMs: Date.now() - startedAt });
  } catch (error) {
    // Never rethrow: a failed run is recoverable on the next tick.
    logger.error("Assistant chat retention failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
