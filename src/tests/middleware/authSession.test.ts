/**
 * Unit tests for authSession middleware and getAuth helper.
 * Test library/framework: Vitest
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock only external package; for internal modules we use spies to share the same module instance.
vi.mock("better-auth/node", () => ({
  fromNodeHeaders: vi.fn((headers: any) => ({ mocked: true, headers })),
}));

import { authSession, getAuth, type AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { auth } from "../../utils/auth.js";
import { logger } from "../../middleware/logger.js";
import { fromNodeHeaders } from "better-auth/node";

type NextFn = NextFunction & { mock?: any };

const makeReqResNext = () => {
  const req = { headers: { "x-req-id": "test-123" } } as unknown as Request;
  const res = {} as unknown as Response;
  const next = vi.fn() as unknown as NextFn;
  return { req, res, next };
};

describe("authSession middleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Ensure getSession is a mock for each test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api = (auth as any).api ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api.getSession = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls getSession with headers from fromNodeHeaders and forwards AppError(401) on missing session", async () => {
    const { req, res, next } = makeReqResNext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api.getSession.mockResolvedValue(null);

    await authSession(req, res, next);

    expect(fromNodeHeaders).toHaveBeenCalledTimes(1);
    expect(fromNodeHeaders).toHaveBeenCalledWith(req.headers);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArg = (auth as any).api.getSession.mock.calls[0][0];
    expect(callArg).toHaveProperty("headers");
    expect(callArg.headers).toEqual(expect.objectContaining({ mocked: true }));

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as any).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(401);
    expect(err.message).toBe("Unauthorized");
  });

  it("populates req.auth and calls next() with no error when session exists (happy path)", async () => {
    const { req, res, next } = makeReqResNext();
    const fake = {
      session: { id: "sess_123" },
      user: {
        id: "user_1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        emailVerified: true,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api.getSession.mockResolvedValue(fake);

    await authSession(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as any).mock.calls[0].length).toBe(0); // called without args

    // @ts-expect-error augmented by middleware
    expect(req.auth).toEqual<Partial<AuthSession>>({
      sessionId: "sess_123",
      userId: "user_1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      emailVerified: true,
    });
  });

  it("preserves boolean falsy emailVerified field", async () => {
    const { req, res, next } = makeReqResNext();
    const fake = {
      session: { id: "sess_999" },
      user: {
        id: "user_9",
        name: "Grace Hopper",
        email: "grace@example.com",
        emailVerified: false,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api.getSession.mockResolvedValue(fake);

    await authSession(req, res, next);

    // @ts-expect-error augmented by middleware
    expect(req.auth.emailVerified).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("logs and forwards original error when getSession rejects", async () => {
    const { req, res, next } = makeReqResNext();
    const boom = new Error("network down");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api.getSession.mockRejectedValue(boom);

    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    await authSession(req, res, next);

    expect(errorSpy).toHaveBeenCalledWith("authSession", { error: boom });
    expect(next).toHaveBeenCalledTimes(1);
    expect((next as any).mock.calls[0][0]).toBe(boom);
  });

  it("handles malformed session shape by logging and forwarding error", async () => {
    const { req, res, next } = makeReqResNext();
    // Missing nested 'session' and 'user' fields -> will throw inside middleware
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).api.getSession.mockResolvedValue({} as any);

    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    await authSession(req, res, next);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const forwarded = (next as any).mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(Error);
    // Not an AppError(401) path; it's a thrown TypeError from property access
    expect(forwarded).not.toBeInstanceOf(AppError);
  });
});

describe("getAuth helper", () => {
  it("returns req.auth when present", () => {
    const req = { auth: { sessionId: "s", userId: "u" } } as unknown as Request;
    const result = getAuth(req);
    expect(result).toEqual({ sessionId: "s", userId: "u" } as any);
  });

  it("throws AppError(401) when req.auth is missing", () => {
    const req = {} as unknown as Request;
    expect(() => getAuth(req)).toThrow(AppError);
    try {
      getAuth(req);
    } catch (e: any) {
      expect(e.code).toBe(401);
      expect(e.message).toBe("Unauthorized");
    }
  });
});