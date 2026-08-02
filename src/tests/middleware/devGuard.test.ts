/**
 * Unit tests for the devGuard middleware.
 * Test library/framework: Vitest
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../config.js", () => ({
  config: { dev: undefined as { token: string; seedEmailDomain: string } | undefined },
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { devGuard } from "../../middleware/devGuard.js";
import { config } from "../../config.js";
import AppError from "../../utils/appError.js";

const TOKEN = "local-dev-token-0123456789";

const makeReq = (peer: string | undefined, token?: string): Request =>
  ({
    socket: { remoteAddress: peer },
    path: "/status",
    get: (name: string) => (name === "x-dev-token" ? token : undefined),
  }) as unknown as Request;

const run = (req: Request) => {
  const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[][] } };
  devGuard(req, {} as Response, next);
  return next;
};

const errorFrom = (next: { mock: { calls: unknown[][] } }): AppError =>
  next.mock.calls[0]![0] as AppError;

describe("devGuard", () => {
  beforeEach(() => {
    (config as { dev?: { token: string; seedEmailDomain: string } }).dev = {
      token: TOKEN,
      seedEmailDomain: "dev.local",
    };
  });

  it("passes a loopback request carrying the right token", () => {
    const next = run(makeReq("127.0.0.1", TOKEN));
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts IPv6 loopback forms", () => {
    for (const peer of ["::1", "::ffff:127.0.0.1"]) {
      expect(run(makeReq(peer, TOKEN))).toHaveBeenCalledWith();
    }
  });

  it("404s when dev tools are disabled", () => {
    (config as { dev?: unknown }).dev = undefined;
    const error = errorFrom(run(makeReq("127.0.0.1", TOKEN)));
    expect(error.statusCode).toBe(404);
  });

  it("404s a non-loopback peer even with a valid token", () => {
    const error = errorFrom(run(makeReq("10.0.0.5", TOKEN)));
    expect(error.statusCode).toBe(404);
  });

  it("ignores X-Forwarded-For and judges the socket peer only", () => {
    const req = makeReq("10.0.0.5", TOKEN);
    (req as unknown as { headers: Record<string, string> }).headers = {
      "x-forwarded-for": "127.0.0.1",
    };
    expect(errorFrom(run(req)).statusCode).toBe(404);
  });

  it("401s a missing or wrong token from loopback", () => {
    expect(errorFrom(run(makeReq("127.0.0.1"))).statusCode).toBe(401);
    expect(errorFrom(run(makeReq("127.0.0.1", "wrong"))).statusCode).toBe(401);
    expect(errorFrom(run(makeReq("127.0.0.1", `${TOKEN}x`))).statusCode).toBe(401);
  });
});
