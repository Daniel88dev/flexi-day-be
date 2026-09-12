import { describe, it, expect, vi, beforeEach } from "vitest";

const { sweepMock } = vi.hoisted(() => ({ sweepMock: vi.fn() }));

vi.mock("../../services/attendance/attendanceRetention.js", () => ({
  sweepAttendanceLocations: (now: Date) => sweepMock(now),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runAttendanceLocationSweep } from "../attendanceLocationSweepJob.js";
import { logger } from "../../middleware/logger.js";

describe("runAttendanceLocationSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepMock.mockResolvedValue({ sessions: 0 });
  });

  it("sweeps as of now when no clock is given", async () => {
    const before = Date.now();
    await runAttendanceLocationSweep();

    const [now] = sweepMock.mock.calls[0] as [Date];
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("sweeps as of the clock it is given", async () => {
    const at = new Date("2027-03-03T02:00:00Z");
    await runAttendanceLocationSweep(at);

    expect(sweepMock).toHaveBeenCalledWith(at);
  });

  it("reports what it erased", async () => {
    sweepMock.mockResolvedValue({ sessions: 4 });

    await runAttendanceLocationSweep();

    expect(logger.info).toHaveBeenCalledWith(
      "Attendance location sweep erased coordinates",
      expect.objectContaining({ sessions: 4 })
    );
  });

  it("stays quiet when there was nothing to erase", async () => {
    await runAttendanceLocationSweep();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("swallows a failure rather than letting it crash the process", async () => {
    sweepMock.mockRejectedValue(new Error("connection terminated"));

    await expect(runAttendanceLocationSweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Attendance location sweep failed",
      expect.objectContaining({ error: "connection terminated" })
    );
  });
});
