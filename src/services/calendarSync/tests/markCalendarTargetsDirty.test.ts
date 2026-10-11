import { describe, expect, it, vi } from "vitest";

const { update, enqueueSync, logError } = vi.hoisted(() => ({
  update: vi.fn(),
  enqueueSync: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    update,
    select: () => ({ from: () => ({ where: () => ({}) }) }),
  },
}));
vi.mock("../enqueueSync.js", () => ({ enqueueSync }));
vi.mock("../../../middleware/logger.js", () => ({ logger: { error: logError } }));

import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import { markCalendarTargetsDirty } from "../markCalendarTargetsDirty.js";

const row = {
  userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
  vacationType: CalendarRecordType.Vacation,
  approvedAt: new Date(),
};

const updateReturning = (result: () => Promise<{ id: string }[]>) =>
  update.mockReturnValue({ set: () => ({ where: () => ({ returning: result }) }) });

describe("markCalendarTargetsDirty", () => {
  it("enqueues the targets its update marked", async () => {
    updateReturning(() => Promise.resolve([{ id: "target-a" }]));

    await markCalendarTargetsDirty([row]);

    expect(enqueueSync).toHaveBeenCalledWith(["target-a"]);
  });

  it("swallows and logs a failed update", async () => {
    updateReturning(() => Promise.reject(new Error("connection reset")));

    await expect(markCalendarTargetsDirty([row])).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("calendar_sync.mark_dirty_failed", { error: "Error" });
  });

  it("swallows a queue that throws", async () => {
    updateReturning(() => Promise.resolve([{ id: "target-a" }]));
    enqueueSync.mockImplementationOnce(() => {
      throw new Error("queue broke");
    });

    await expect(markCalendarTargetsDirty([row])).resolves.toBeUndefined();
  });

  it("touches nothing for rows that were never approved", async () => {
    update.mockClear();

    await markCalendarTargetsDirty([]);
    await markCalendarTargetsDirty([{ ...row, approvedAt: null }]);

    expect(update).not.toHaveBeenCalled();
  });
});
