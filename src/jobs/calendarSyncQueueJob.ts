import { logger } from "../middleware/logger.js";
import { errorName } from "../utils/errorName.js";
import { calendarSyncQueue } from "../services/calendarSync/enqueueSync.js";
import { getDueCalendarTargetIds } from "../services/calendarSync/syncEngine.js";

/** Boot catch-up: every target still marked due goes back on the queue. */
export const startCalendarSyncQueue = async (): Promise<void> => {
  const queue = calendarSyncQueue();
  if (!queue) return;
  try {
    const due = await getDueCalendarTargetIds();
    queue.enqueue(due);
    logger.info("Calendar sync queue started", { due: due.length });
  } catch (error) {
    logger.error("Calendar sync catch-up failed", { error: errorName(error) });
  }
};

export const stopCalendarSyncQueue = (): void => {
  calendarSyncQueue()?.stop();
};
