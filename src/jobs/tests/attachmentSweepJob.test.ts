import { describe, it, expect, vi, beforeEach } from "vitest";

const { sweepMock } = vi.hoisted(() => ({ sweepMock: vi.fn() }));

vi.mock("../../services/attachment/attachmentRetention.js", () => ({
  sweepAttachments: (now: Date) => sweepMock(now),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runAttachmentSweep } from "../attachmentSweepJob.js";
import { logger } from "../../middleware/logger.js";

describe("runAttachmentSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepMock.mockResolvedValue({ expired: 0, noLiveDay: 0, stale: 0 });
  });

  it("sweeps as of now when no clock is given", async () => {
    const before = Date.now();
    await runAttachmentSweep();

    const [now] = sweepMock.mock.calls[0] as [Date];
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("sweeps as of the clock it is given", async () => {
    const at = new Date("2027-03-03T02:00:00Z");
    await runAttachmentSweep(at);

    expect(sweepMock).toHaveBeenCalledWith(at);
  });

  it("reports what it removed", async () => {
    sweepMock.mockResolvedValue({ expired: 2, noLiveDay: 1, stale: 3 });

    await runAttachmentSweep();

    expect(logger.info).toHaveBeenCalledWith(
      "Attachment sweep removed attachments",
      expect.objectContaining({ expired: 2, noLiveDay: 1, stale: 3 })
    );
  });

  it("stays quiet when there was nothing to remove", async () => {
    await runAttachmentSweep();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("swallows a failure rather than letting it crash the process", async () => {
    sweepMock.mockRejectedValue(new Error("connection terminated"));

    await expect(runAttachmentSweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Attachment sweep failed",
      expect.objectContaining({ error: "connection terminated" })
    );
  });
});
