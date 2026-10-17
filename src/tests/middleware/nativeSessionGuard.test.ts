import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireNativeSession } from "../../middleware/nativeSessionGuard.js";
import AppError from "../../utils/appError.js";
import { mockAuthData } from "../testUtils.js";

const run = (auth: Request["auth"]) => {
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  requireNativeSession({ auth } as Request, {} as Response, next);
  return next.mock.calls[0]?.[0] as unknown;
};

describe("requireNativeSession", () => {
  it("lets a Native session through", () => {
    expect(run({ ...mockAuthData, deviceId: "11111111-2222-4333-8444-555555555555" })).toBe(
      undefined
    );
  });

  it("refuses a web session with NATIVE_SESSION_REQUIRED", () => {
    const error = run(mockAuthData);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(403);
    expect((error as AppError).errors[0]?.publicContext.reason).toBe("NATIVE_SESSION_REQUIRED");
  });

  it("answers 401 without a session", () => {
    const error = run(undefined);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(401);
  });
});
