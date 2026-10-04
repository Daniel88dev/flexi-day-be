import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStore } = vi.hoisted(() => ({ mockStore: vi.fn() }));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/appleAuthorization/appleAuthorizationServices.js", () => ({
  storeAppleAuthorization: mockStore,
}));

import { handlePostAppleAuthorization } from "../handlePostAppleAuthorization.js";
import { getAuth } from "../../../middleware/authSession.js";
import AppError from "../../../utils/appError.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const nativeSession = { ...mockAuthData, deviceId: "11111111-2222-4333-8444-555555555555" };

const authorize = () => {
  const { req, res } = makeReqRes({ body: { authorizationCode: "c0de.0.abc" } });
  const extended = res as Response & { end: ReturnType<typeof vi.fn> };
  extended.end = vi.fn().mockReturnThis();
  return { req: req as Request, res: extended };
};

const refusalOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  return { code: appError.code, reason: appError.errors[0]?.publicContext.reason };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuth).mockReturnValue(nativeSession);
  mockStore.mockResolvedValue({ stored: true });
});

describe("POST /api/users/me/apple-authorization", () => {
  it("refuses a web session before doing anything", async () => {
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    const { req, res } = authorize();

    expect(await refusalOf(handlePostAppleAuthorization(req, res))).toEqual({
      code: 403,
      reason: "NATIVE_SESSION_REQUIRED",
    });
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("answers 204 once the tokens are stored", async () => {
    const { req, res } = authorize();

    await handlePostAppleAuthorization(req, res);

    expect(mockStore).toHaveBeenCalledWith(mockAuthData.userId, "c0de.0.abc");
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([
    ["APPLE_ACCOUNT_MISSING", 409],
    ["APPLE_SUBJECT_MISMATCH", 409],
    ["APPLE_EXCHANGE_FAILED", 502],
  ])("answers %s with %i", async (refusal, code) => {
    mockStore.mockResolvedValue({ stored: false, refusal });
    const { req, res } = authorize();

    expect(await refusalOf(handlePostAppleAuthorization(req, res))).toEqual({
      code,
      reason: refusal,
    });
    expect(res.status).not.toHaveBeenCalled();
  });
});
