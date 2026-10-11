import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncQueue } from "../enqueueSync.js";
import type { SyncOutcome } from "../types.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe("calendar sync queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces every change to a target within five seconds into one sync", async () => {
    const run = vi.fn((): Promise<SyncOutcome> => Promise.resolve({ status: "done" }));
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    queue.enqueue(["target-a", "target-b"]);
    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run.mock.calls).toEqual([["target-a"]]);

    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(run.mock.calls).toEqual([["target-a"], ["target-b"]]);
  });

  it("runs one sync per target at a time and runs again for a change that arrived meanwhile", async () => {
    let finish!: () => void;
    const run = vi
      .fn<(targetId: string) => Promise<SyncOutcome>>()
      .mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve({ status: "done" })))
      )
      .mockResolvedValue({ status: "done" });
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(run).toHaveBeenCalledTimes(1);

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries a failing target after 5 s, 30 s, 5 min and 30 min, then gives up", async () => {
    let attempts = 0;
    const run = vi.fn((): Promise<SyncOutcome> =>
      Promise.resolve({ status: "retry", attempts: ++attempts })
    );
    const queue = createSyncQueue({ run });
    const runsAfter = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      return run.mock.calls.length;
    };

    queue.enqueue(["target-a"]);
    expect(await runsAfter(5 * SECOND)).toBe(1);
    expect(await runsAfter(5 * SECOND - 1)).toBe(1);
    expect(await runsAfter(1)).toBe(2);
    expect(await runsAfter(30 * SECOND - 1)).toBe(2);
    expect(await runsAfter(1)).toBe(3);
    expect(await runsAfter(5 * MINUTE - 1)).toBe(3);
    expect(await runsAfter(1)).toBe(4);
    expect(await runsAfter(30 * MINUTE - 1)).toBe(4);
    expect(await runsAfter(1)).toBe(5);
    expect(await runsAfter(24 * 60 * MINUTE)).toBe(5);
  });

  it("waits out the provider's Retry-After instead of the backoff step", async () => {
    const run = vi
      .fn<(targetId: string) => Promise<SyncOutcome>>()
      .mockResolvedValueOnce({ status: "throttled", retryAfterSeconds: 120 })
      .mockResolvedValue({ status: "done" });
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND + 120 * SECOND - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("ends endless throttling after six reschedules", async () => {
    const run = vi.fn((): Promise<SyncOutcome> =>
      Promise.resolve({ status: "throttled", retryAfterSeconds: 1 })
    );
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND + 10 * SECOND);

    expect(run).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("comes back after 30 s while another instance holds the lease, without giving up", async () => {
    const run = vi
      .fn<(targetId: string) => Promise<SyncOutcome>>()
      .mockResolvedValueOnce({ status: "busy" })
      .mockResolvedValueOnce({ status: "busy" })
      .mockResolvedValue({ status: "done" });
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND + 30 * SECOND - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 30 * SECOND);

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("cuts a long backoff short when a new change arrives", async () => {
    const run = vi
      .fn<(targetId: string) => Promise<SyncOutcome>>()
      .mockResolvedValueOnce({ status: "retry", attempts: 4 })
      .mockResolvedValue({ status: "done" });
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps going after a run throws", async () => {
    const run = vi
      .fn<(targetId: string) => Promise<SyncOutcome>>()
      .mockRejectedValueOnce(new Error("database down"))
      .mockResolvedValue({ status: "done" });
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    queue.enqueue(["target-a"]);
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("clears every timer on stop and takes no more work", async () => {
    const run = vi.fn((): Promise<SyncOutcome> => Promise.resolve({ status: "done" }));
    const queue = createSyncQueue({ run });

    queue.enqueue(["target-a", "target-b"]);
    queue.stop();
    queue.enqueue(["target-c"]);
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the timers it is given", () => {
    const setTimeout = vi.fn(() => "handle");
    const clearTimeout = vi.fn();
    const queue = createSyncQueue({
      run: () => Promise.resolve({ status: "done" }),
      timers: { setTimeout, clearTimeout },
    });

    queue.enqueue(["target-a"]);
    queue.stop();

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 5 * SECOND);
    expect(clearTimeout).toHaveBeenCalledWith("handle");
  });
});
