import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpsert, mockDelete } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/pushRegistration/pushRegistrationServices.js", () => ({
  upsertPushRegistration: mockUpsert,
  deletePushRegistration: mockDelete,
}));

import { handlePutPushRegistration } from "../handlePutPushRegistration.js";
import { handleDeletePushRegistration } from "../handleDeletePushRegistration.js";
import { getAuth } from "../../../middleware/authSession.js";
import AppError from "../../../utils/appError.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const nativeSession = { ...mockAuthData, deviceId: "11111111-2222-4333-8444-555555555555" };
const body = { token: "ab".repeat(32), environment: "sandbox" };

const call = (handler: (req: Request, res: Response) => Promise<unknown>) => {
  const { req, res } = makeReqRes({ body });
  const extended = res as Response & { end: ReturnType<typeof vi.fn> };
  extended.end = vi.fn().mockReturnThis();
  return { run: () => handler(req as Request, extended), res: extended };
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
  mockUpsert.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
});

describe.each([
  ["PUT", handlePutPushRegistration, mockUpsert],
  ["DELETE", handleDeletePushRegistration, mockDelete],
])("%s /api/users/me/push-registration", (_, handler, service) => {
  it("refuses a web session before touching a registration", async () => {
    vi.mocked(getAuth).mockReturnValue(mockAuthData);

    expect(await refusalOf(call(handler).run())).toEqual({
      code: 403,
      reason: "NATIVE_SESSION_REQUIRED",
    });
    expect(service).not.toHaveBeenCalled();
  });

  it("acts on the caller's own session and answers 204", async () => {
    const { run, res } = call(handler);

    await run();

    expect(service.mock.calls[0]?.[0]).toBe(mockAuthData.sessionId);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});
