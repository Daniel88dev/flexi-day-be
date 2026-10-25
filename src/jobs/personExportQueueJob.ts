import { logger } from "../middleware/logger.js";
import { errorName } from "../utils/errorName.js";
import { getPendingExportIds } from "../services/personExport/personExportBuild.js";
import { personExportQueue } from "../services/personExport/personExportQueue.js";

/** Boot catch-up: every export still `PENDING`, a build cut off by a restart included, goes back on the queue. */
export const startPersonExportQueue = async (): Promise<void> => {
  const queue = personExportQueue();
  if (!queue) return;
  try {
    const pending = await getPendingExportIds();
    queue.enqueue(pending);
    logger.info("Person export queue started", { pending: pending.length });
  } catch (error) {
    logger.error("Person export catch-up failed", { error: errorName(error) });
  }
};

export const stopPersonExportQueue = (): void => {
  personExportQueue()?.stop();
};
