/**
 * Unit tests for the supportGuard middleware.
 * Test library/framework: Vitest
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../config.js", () => ({
  config: { support: undefined as { userIds: string[] } | undefined },
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const selectResult = vi.hoisted(() => ({ rows: [] as { twoFactorEnabled: boolean | null }[] }));

vi.mock("../../db/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResult.rows) }),
      }),
    }),
  },
}));

const recordSupportAccess = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../../services/support/supportServices.js", () => ({
  recordSupportAccess,
}));

import { requireSupportAdmin } from "../../middleware/supportGuard.js";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";

const ADMIN_ID = "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b";

const makeReq = (userId: string): Request =>
  ({
    auth: {
      sessionId: "s",
      userId,
      userName: "n",
      userEmail: "e@example.com",
      emailVerified: true,
    },
    method: "GET",
    baseUrl: "/api/support",
    path: "/organizations",
    originalUrl: "/api/support/organizations?query=jane%40acme.com",
  }) as unknown as Request;

const run = async (req: Request) => {
  const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[][] } };
  await requireSupportAdmin(req, {} as Response, next);
  return next;
};

const errorFrom = (next: { mock: { calls: unknown[][] } }): AppError =>
  next.mock.calls[0]![0] as AppError;

describe("requireSupportAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as { support?: { userIds: string[] } }).support = { userIds: [ADMIN_ID] };
    selectResult.rows = [{ twoFactorEnabled: true }];
  });

  it("passes an allowlisted 2FA-enabled caller and audits the full request target", async () => {
    const next = await run(makeReq(ADMIN_ID));
    expect(next).toHaveBeenCalledWith();
    // The audit row keeps the query string on purpose — for the search
    // endpoint the query IS the target the trail exists to record.
    expect(recordSupportAccess).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      method: "GET",
      path: "/api/support/organizations?query=jane%40acme.com",
    });
  });

  it("404s a caller who is not on the allowlist without logging the query string", async () => {
    const next = await run(makeReq("someoneelse00000000000000000000x"));
    const err = errorFrom(next);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
    expect(recordSupportAccess).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("supportGuard rejected non-allowlisted request", {
      userId: "someoneelse00000000000000000000x",
      path: "/api/support/organizations",
    });
  });

  it("404s everyone when the allowlist is not configured", async () => {
    (config as { support?: { userIds: string[] } }).support = undefined;
    const next = await run(makeReq(ADMIN_ID));
    expect(errorFrom(next).statusCode).toBe(404);
  });

  it("403s an allowlisted caller without two-factor enabled", async () => {
    selectResult.rows = [{ twoFactorEnabled: false }];
    const next = await run(makeReq(ADMIN_ID));
    expect(errorFrom(next).statusCode).toBe(403);
    expect(recordSupportAccess).not.toHaveBeenCalled();
  });

  it("403s when the user row is missing", async () => {
    selectResult.rows = [];
    const next = await run(makeReq(ADMIN_ID));
    expect(errorFrom(next).statusCode).toBe(403);
  });
});
