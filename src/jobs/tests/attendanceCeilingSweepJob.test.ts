import { describe, it, expect, vi, beforeEach } from "vitest";

const { sweepMock } = vi.hoisted(() => ({ sweepMock: vi.fn() }));

vi.mock("../../services/attendance/attendanceCeilings.js", () => ({
  sweepAttendanceCeilings: (now: Date) => sweepMock(now),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runAttendanceCeilingSweep } from "../attendanceCeilingSweepJob.js";
import { logger } from "../../middleware/logger.js";

describe("runAttendanceCeilingSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepMock.mockResolvedValue({ sessions: 0, breaks: 0 });
  });

  it("sweeps as of now when no clock is given", async () => {
    const before = Date.now();
    await runAttendanceCeilingSweep();

    const [now] = sweepMock.mock.calls[0] as [Date];
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("sweeps as of the clock it is given", async () => {
    const at = new Date("2027-03-03T02:00:00Z");
    await runAttendanceCeilingSweep(at);

    expect(sweepMock).toHaveBeenCalledWith(at);
  });

  it("reports what it closed", async () => {
    sweepMock.mockResolvedValue({ sessions: 2, breaks: 1 });

    await runAttendanceCeilingSweep();

    expect(logger.info).toHaveBeenCalledWith(
      "Attendance ceiling sweep closed overdue clocks",
      expect.objectContaining({ sessions: 2, breaks: 1 })
    );
  });

  it("reports a pass that closed only breaks", async () => {
    sweepMock.mockResolvedValue({ sessions: 0, breaks: 3 });

    await runAttendanceCeilingSweep();

    expect(logger.info).toHaveBeenCalledWith(
      "Attendance ceiling sweep closed overdue clocks",
      expect.objectContaining({ sessions: 0, breaks: 3 })
    );
  });

  it("stays quiet when there was nothing left open", async () => {
    await runAttendanceCeilingSweep();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("swallows a failure rather than letting it crash the process", async () => {
    sweepMock.mockRejectedValue(new Error("connection terminated"));

    await expect(runAttendanceCeilingSweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Attendance ceiling sweep failed",
      expect.objectContaining({ error: "connection terminated" })
    );
  });
});
