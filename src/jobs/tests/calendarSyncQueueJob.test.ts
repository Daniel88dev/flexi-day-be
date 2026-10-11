import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDueCalendarTargetIds } = vi.hoisted(() => ({ getDueCalendarTargetIds: vi.fn() }));

vi.mock("../../config.js", () => ({
  config: { api: { env: "test" }, calendarSync: { driver: "fake" } },
}));
vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/calendarSync/syncEngine.js", () => ({
  syncTarget: vi.fn(),
  getDueCalendarTargetIds,
}));

import { startCalendarSyncQueue, stopCalendarSyncQueue } from "../calendarSyncQueueJob.js";
import {
  createSyncQueue,
  enqueueSync,
  installCalendarSyncQueue,
} from "../../services/calendarSync/enqueueSync.js";
import type { SyncOutcome } from "../../services/calendarSync/types.js";

describe("calendar sync queue job", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getDueCalendarTargetIds.mockReset().mockResolvedValue(["due-a", "due-b"]);
  });

  afterEach(() => {
    stopCalendarSyncQueue();
    installCalendarSyncQueue(undefined);
    vi.useRealTimers();
  });

  it("enqueues every target still marked due at boot", async () => {
    const run = vi.fn((): Promise<SyncOutcome> => Promise.resolve({ status: "done" }));
    installCalendarSyncQueue(createSyncQueue({ run }));

    await startCalendarSyncQueue();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(run.mock.calls).toEqual([["due-a"], ["due-b"]]);
  });

  it("does nothing under NODE_ENV=test unless a test installs a queue", async () => {
    await startCalendarSyncQueue();
    enqueueSync(["due-a"]);

    expect(getDueCalendarTargetIds).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a failed catch-up query", async () => {
    installCalendarSyncQueue(createSyncQueue({ run: vi.fn() }));
    getDueCalendarTargetIds.mockRejectedValue(new Error("database down"));

    await expect(startCalendarSyncQueue()).resolves.toBeUndefined();
  });

  it("stops the queue's timers on shutdown", async () => {
    const run = vi.fn((): Promise<SyncOutcome> => Promise.resolve({ status: "done" }));
    installCalendarSyncQueue(createSyncQueue({ run }));
    await startCalendarSyncQueue();

    stopCalendarSyncQueue();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never throws into the caller when the queue fails", () => {
    installCalendarSyncQueue({
      enqueue: () => {
        throw new Error("queue broke");
      },
      drain: () => Promise.resolve(),
      stop: () => undefined,
    });

    expect(() => enqueueSync(["due-a"])).not.toThrow();
  });
});
