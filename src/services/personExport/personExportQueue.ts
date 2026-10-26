import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import { buildPersonExport, type ExportBuildOutcome } from "./personExportBuild.js";

export const BUSY_RETRY_MS = 30_000;
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 5 * 60_000, 30 * 60_000];

export interface PersonExportQueue {
  enqueue: (exportIds: readonly string[]) => void;
  /** Runs every waiting build now, retries included, and resolves once nothing is left. */
  drain: () => Promise<void>;
  stop: () => void;
}

type Entry = { timer?: ReturnType<typeof setTimeout>; running?: Promise<void> };

/**
 * In-process delivery like calendar sync's: one build per export at a time,
 * a busy lock or a failure comes back after a delay. The row's `PENDING`
 * status is what survives a restart.
 */
export const createPersonExportQueue = (options: {
  run?: (exportId: string) => Promise<ExportBuildOutcome>;
  retryDelaysMs?: readonly number[];
  busyRetryMs?: number;
}): PersonExportQueue => {
  const run = options.run ?? ((exportId: string) => buildPersonExport(exportId));
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_MS;
  const entries = new Map<string, Entry>();
  let stopped = false;

  const fire = (exportId: string, entry: Entry) => {
    entry.timer = undefined;
    entry.running = (async () => {
      let outcome: ExportBuildOutcome;
      try {
        outcome = await run(exportId);
      } catch (error) {
        logger.error("person_export.run_failed", { exportId, error: errorName(error) });
        outcome = { status: "busy" };
      }
      entry.running = undefined;
      if (stopped) return;
      const delay =
        outcome.status === "busy"
          ? busyRetryMs
          : outcome.status === "retry"
            ? retryDelays[outcome.attempts - 1]
            : undefined;
      if (delay === undefined) {
        entries.delete(exportId);
        return;
      }
      entry.timer = setTimeout(() => fire(exportId, entry), delay);
    })();
  };

  return {
    enqueue: (exportIds) => {
      if (stopped) return;
      for (const exportId of new Set(exportIds)) {
        if (entries.has(exportId)) continue;
        const entry: Entry = {};
        entries.set(exportId, entry);
        fire(exportId, entry);
      }
    },
    drain: async () => {
      for (;;) {
        for (const [exportId, entry] of entries) {
          if (entry.timer !== undefined) {
            clearTimeout(entry.timer);
            fire(exportId, entry);
          }
        }
        const running = [...entries.values()].flatMap((entry) =>
          entry.running ? [entry.running] : []
        );
        if (running.length === 0) return;
        await Promise.all(running);
      }
    },
    stop: () => {
      stopped = true;
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
};

let installed: PersonExportQueue | undefined;

/** Swaps the process queue; tests use it to opt in under `NODE_ENV=test`. */
export const installPersonExportQueue = (queue: PersonExportQueue | undefined): void => {
  if (installed !== queue) installed?.stop();
  installed = queue;
};

/** The process queue, absent under `NODE_ENV=test` unless a test installed one. */
export const personExportQueue = (): PersonExportQueue | undefined => {
  if (!installed && config.api.env !== "test") installed = createPersonExportQueue({});
  return installed;
};

/** Never throws: the request has committed, and the row survives for the boot catch-up. */
export const enqueuePersonExport = (exportId: string): void => {
  try {
    personExportQueue()?.enqueue([exportId]);
  } catch (error) {
    logger.error("person_export.enqueue_failed", { exportId, error: errorName(error) });
  }
};
