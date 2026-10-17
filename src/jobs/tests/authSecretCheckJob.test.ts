import { describe, it, expect, vi, beforeEach } from "vitest";

const { checkMock, SECRET } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  SECRET: "effective-secret-Kq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE",
}));

vi.mock("../../utils/auth.js", () => ({
  auth: { $context: Promise.resolve({ secret: SECRET }) },
}));

vi.mock("../../services/authSecret/authSecretServices.js", () => ({
  checkAuthSecret: (secret: string) => checkMock(secret),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { runAuthSecretCheck } from "../authSecretCheckJob.js";
import { logger } from "../../middleware/logger.js";

const everyLogLine = () =>
  JSON.stringify([
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.debug).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ]);

describe("runAuthSecretCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkMock.mockResolvedValue({ outcome: "unchanged", sessionsDeleted: 0 });
  });

  it("checks the secret better-auth signs with", async () => {
    await runAuthSecretCheck();

    expect(checkMock).toHaveBeenCalledWith(SECRET);
  });

  it("reports a rotation and how many sessions it ended, without the secret", async () => {
    checkMock.mockResolvedValue({ outcome: "rotated", sessionsDeleted: 7 });

    await runAuthSecretCheck();

    expect(logger.warn).toHaveBeenCalledWith(
      "auth.secret_rotated",
      expect.objectContaining({ sessionsDeleted: 7 })
    );
    expect(everyLogLine()).not.toContain(SECRET);
  });

  it("logs a failure and lets the server keep booting", async () => {
    checkMock.mockRejectedValue(new Error("connection refused"));

    await expect(runAuthSecretCheck()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "Auth secret check failed",
      expect.objectContaining({ error: "connection refused" })
    );
    expect(everyLogLine()).not.toContain(SECRET);
  });
});
