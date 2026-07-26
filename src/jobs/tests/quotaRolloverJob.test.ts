import { describe, it, expect, vi, beforeEach } from "vitest";

const rolloverMock = vi.fn();

vi.mock("../../services/quotaRollover/quotaRolloverServices.js", () => ({
  rolloverQuotasForYear: (year: number) => rolloverMock(year),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runQuotaRollover } from "../quotaRolloverJob.js";
import { logger } from "../../middleware/logger.js";

describe("runQuotaRollover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rolloverMock.mockResolvedValue({ year: 2027, created: 0, skipped: false });
  });

  it("rolls over the current year when no year is given", async () => {
    await runQuotaRollover();

    expect(rolloverMock).toHaveBeenCalledWith(new Date().getFullYear());
  });

  it("rolls over an explicit year when asked", async () => {
    await runQuotaRollover(2030);

    expect(rolloverMock).toHaveBeenCalledWith(2030);
  });

  it("reports how many allowances it opened", async () => {
    rolloverMock.mockResolvedValue({ year: 2027, created: 12, skipped: false });

    await runQuotaRollover(2027);

    expect(logger.info).toHaveBeenCalledWith(
      "Quota rollover created new allowances",
      expect.objectContaining({ year: 2027, created: 12 })
    );
  });

  it("stays quiet when there was nothing to open", async () => {
    await runQuotaRollover(2027);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("stays quiet when another instance holds the lock", async () => {
    rolloverMock.mockResolvedValue({ year: 2027, created: 0, skipped: true });

    await runQuotaRollover(2027);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("swallows a failure rather than letting it crash the process", async () => {
    rolloverMock.mockRejectedValue(new Error("connection terminated"));

    await expect(runQuotaRollover(2027)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Quota rollover failed",
      expect.objectContaining({ year: 2027, error: "connection terminated" })
    );
  });
});
