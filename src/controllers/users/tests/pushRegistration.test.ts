import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpsert, mockDelete } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: (run: (tx: unknown) => unknown) => run({}) },
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/pushRegistration/pushRegistrationServices.js", () => ({
  upsertPushRegistration: mockUpsert,
  deletePushRegistration: mockDelete,
}));

import { handlePutPushRegistration } from "../handlePutPushRegistration.js";
import { handleDeletePushRegistration } from "../handleDeletePushRegistration.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const nativeSession = { ...mockAuthData, deviceId: "11111111-2222-4333-8444-555555555555" };
const body = { token: "ab".repeat(32), environment: "sandbox" };

const call = (handler: (req: Request, res: Response) => Promise<unknown>) => {
  const { req, res } = makeReqRes({ body });
  const extended = res as Response & { end: ReturnType<typeof vi.fn> };
  extended.end = vi.fn().mockReturnThis();
  return { run: () => handler(req as Request, extended), res: extended };
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
  it("acts on the caller's own session and answers 204", async () => {
    const { run, res } = call(handler);

    await run();

    expect(service.mock.calls[0]?.[0]).toBe(mockAuthData.sessionId);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});
