import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import { syncTarget } from "./syncEngine.js";
import type { SyncOutcome, SyncQueueTimers } from "./types.js";

export const COALESCE_MS = 5_000;
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 5 * 60_000, 30 * 60_000];
export const BUSY_RETRY_MS = 30_000;
export const MAX_THROTTLED_RETRIES = 6;

export interface SyncQueue {
  enqueue: (targetIds: readonly string[]) => void;
  /** Runs every target waiting out its coalescing window now and resolves once all runs end. */
  drain: () => Promise<void>;
  stop: () => void;
}

type Entry = {
  timer?: unknown;
  retrying: boolean;
  running?: Promise<void>;
  again: boolean;
  throttles: number;
};

const globalTimers: SyncQueueTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * In-process delivery: a change waits out a coalescing window, each target
 * runs one sync at a time, and failures come back after a growing delay until
 * the delays run out. The target's `syncDueAt` is what survives a restart.
 */
export const createSyncQueue = (options: {
  run: (targetId: string) => Promise<SyncOutcome>;
  timers?: SyncQueueTimers;
  coalesceMs?: number;
  retryDelaysMs?: readonly number[];
}): SyncQueue => {
  const timers = options.timers ?? globalTimers;
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const entries = new Map<string, Entry>();
  let stopped = false;

  const schedule = (targetId: string, entry: Entry, ms: number, retrying: boolean) => {
    entry.retrying = retrying;
    entry.timer = timers.setTimeout(() => {
      entry.timer = undefined;
      fire(targetId, entry);
    }, ms);
  };

  const giveUp = (targetId: string, details: Record<string, unknown>) => {
    logger.warn("calendar_sync.gave_up", { targetId, ...details });
    entries.delete(targetId);
  };

  const settle = (targetId: string, entry: Entry, outcome: SyncOutcome) => {
    if (stopped) return;
    if (entry.again) {
      entry.again = false;
      entry.throttles = 0;
      schedule(targetId, entry, coalesceMs, false);
      return;
    }
    switch (outcome.status) {
      case "done":
        entries.delete(targetId);
        return;
      case "busy":
        schedule(targetId, entry, BUSY_RETRY_MS, true);
        return;
      case "throttled": {
        entry.throttles += 1;
        if (entry.throttles > MAX_THROTTLED_RETRIES) {
          giveUp(targetId, { throttles: entry.throttles });
          return;
        }
        const step = retryDelays[Math.min(entry.throttles, retryDelays.length) - 1] ?? coalesceMs;
        const delay = outcome.retryAfterSeconds !== null ? outcome.retryAfterSeconds * 1000 : step;
        schedule(targetId, entry, delay, true);
        return;
      }
      case "retry": {
        const delay = retryDelays[outcome.attempts - 1];
        if (delay === undefined) {
          giveUp(targetId, { attempts: outcome.attempts });
          return;
        }
        schedule(targetId, entry, delay, true);
      }
    }
  };

  const fire = (targetId: string, entry: Entry) => {
    entry.running = (async () => {
      let outcome: SyncOutcome = { status: "done" };
      try {
        outcome = await options.run(targetId);
      } catch (error) {
        logger.error("calendar_sync.run_failed", { targetId, error: errorName(error) });
      }
      entry.running = undefined;
      settle(targetId, entry, outcome);
    })();
  };

  return {
    enqueue: (targetIds) => {
      if (stopped) return;
      for (const targetId of new Set(targetIds)) {
        const entry = entries.get(targetId);
        if (!entry) {
          const created: Entry = { retrying: false, again: false, throttles: 0 };
          entries.set(targetId, created);
          schedule(targetId, created, coalesceMs, false);
        } else if (entry.running) {
          entry.again = true;
        } else if (entry.retrying) {
          // A fresh change does not wait out a long backoff.
          timers.clearTimeout(entry.timer);
          entry.throttles = 0;
          schedule(targetId, entry, coalesceMs, false);
        }
      }
    },

    drain: async () => {
      for (;;) {
        for (const [targetId, entry] of entries) {
          if (entry.timer !== undefined && !entry.retrying) {
            timers.clearTimeout(entry.timer);
            entry.timer = undefined;
            fire(targetId, entry);
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
        if (entry.timer !== undefined) timers.clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
};

let installed: SyncQueue | undefined;

/** Swaps the process queue; tests use it to opt in under `NODE_ENV=test`. */
export const installCalendarSyncQueue = (queue: SyncQueue | undefined): void => {
  if (installed !== queue) installed?.stop();
  installed = queue;
};

/** The process queue, absent under `NODE_ENV=test` unless a test installed one, and while sync is off. */
export const calendarSyncQueue = (): SyncQueue | undefined => {
  if (!installed && config.api.env !== "test" && config.calendarSync) {
    installed = createSyncQueue({ run: (targetId) => syncTarget(targetId) });
  }
  return installed;
};

/**
 * Hands targets whose `syncDueAt` is set to the queue. Never throws: a caller
 * has already committed, and the due marker survives for the boot catch-up.
 */
export const enqueueSync = (targetIds: readonly string[]): void => {
  if (targetIds.length === 0) return;
  try {
    calendarSyncQueue()?.enqueue(targetIds);
  } catch (error) {
    logger.error("calendar_sync.enqueue_failed", { targetIds, error: errorName(error) });
  }
};
