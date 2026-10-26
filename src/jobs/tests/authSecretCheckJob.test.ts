import { describe, it, expect, vi, beforeEach } from "vitest";

const { checkMock, reencryptMock, SECRET, SECRET_CONFIG } = vi.hoisted(() => {
  const SECRET = "effective-secret-Kq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE";
  return {
    checkMock: vi.fn(),
    reencryptMock: vi.fn(),
    SECRET,
    SECRET_CONFIG: { keys: new Map([[2, SECRET]]), currentVersion: 2 },
  };
});

vi.mock("../../utils/auth.js", () => ({
  auth: { $context: Promise.resolve({ secret: SECRET, secretConfig: SECRET_CONFIG }) },
}));

vi.mock("../../services/authSecret/authSecretServices.js", () => ({
  checkAuthSecret: (secret: string) => checkMock(secret),
}));

vi.mock("../../services/authSecret/reencryptServices.js", () => ({
  reencryptToCurrentVersion: (key: unknown) => reencryptMock(key),
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
    reencryptMock.mockResolvedValue({ reencrypted: 0, unreadable: {} });
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
      "auth.secret_check_failed",
      expect.objectContaining({ error: "connection refused" })
    );
    expect(everyLogLine()).not.toContain(SECRET);
  });

  it("moves rows onto the current version and says how many, without the secret", async () => {
    reencryptMock.mockResolvedValue({ reencrypted: 3, unreadable: {} });

    await runAuthSecretCheck();

    expect(reencryptMock).toHaveBeenCalledWith(SECRET_CONFIG);
    expect(logger.info).toHaveBeenCalledWith("auth.secret_reencrypted", { version: 2, rows: 3 });
    expect(everyLogLine()).not.toContain(SECRET);
  });

  it("reports rows no held key opens", async () => {
    reencryptMock.mockResolvedValue({
      reencrypted: 0,
      unreadable: { "two_factor.secret": ["row-1"] },
    });

    await runAuthSecretCheck();

    expect(logger.error).toHaveBeenCalledWith("auth.secret_unreadable_rows", {
      unreadable: { "two_factor.secret": ["row-1"] },
    });
  });

  it("still re-encrypts when the session check fails, and survives its own failure", async () => {
    checkMock.mockRejectedValue(new Error("connection refused"));
    reencryptMock.mockRejectedValue(new Error("still refused"));

    await expect(runAuthSecretCheck()).resolves.toBeUndefined();

    expect(reencryptMock).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "auth.secret_reencrypt_failed",
      expect.objectContaining({ error: "still refused" })
    );
  });
});
