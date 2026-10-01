import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetBlockers,
  mockGetConfirmation,
  mockGetHash,
  mockGetSessionCreatedAt,
  mockDeleteAccount,
  mockRemoveObjects,
  mockVerify,
} = vi.hoisted(() => ({
  mockGetBlockers: vi.fn(),
  mockGetConfirmation: vi.fn(),
  mockGetHash: vi.fn(),
  mockGetSessionCreatedAt: vi.fn(),
  mockDeleteAccount: vi.fn(),
  mockRemoveObjects: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/accountDeletion/accountDeletionServices.js", () => ({
  getDeletionBlockers: mockGetBlockers,
  getDeletionConfirmation: mockGetConfirmation,
  getCredentialPasswordHash: mockGetHash,
  getSessionCreatedAt: mockGetSessionCreatedAt,
  deleteAccountRows: mockDeleteAccount,
  removeAttachmentObjects: mockRemoveObjects,
}));

const TX = { stand: "in" };
vi.mock("../../../db/db.js", () => ({
  db: { transaction: (cb: (tx: unknown) => unknown) => cb(TX) },
}));

vi.mock("../../../utils/auth.js", () => {
  const cookie = (name: string) => ({
    name,
    attributes: { secure: false, sameSite: "lax", path: "/", httpOnly: true },
  });
  return {
    auth: {
      $context: Promise.resolve({
        password: { verify: mockVerify },
        authCookies: {
          sessionToken: cookie("better-auth.session_token"),
          sessionData: cookie("better-auth.session_data"),
          dontRememberToken: cookie("better-auth.dont_remember"),
        },
      }),
    },
  };
});

import { handleGetMyDeletion } from "../handleGetMyDeletion.js";
import { handlePostDeleteMe } from "../handlePostDeleteMe.js";
import { getAuth } from "../../../middleware/authSession.js";
import AppError from "../../../utils/appError.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const HOUR_MS = 60 * 60 * 1000;

const deleteRequest = (body: Record<string, unknown> = {}) => {
  const { req, res } = makeReqRes({ body });
  const extended = res as Response & { end: ReturnType<typeof vi.fn> };
  extended.end = vi.fn().mockReturnThis();
  (extended as unknown as { clearCookie: ReturnType<typeof vi.fn> }).clearCookie = vi.fn();
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

describe("account deletion handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    mockDeleteAccount.mockResolvedValue({ groups: 0, organizations: 0, attachments: [] });
  });

  it("reports the blockers and the confirmation the caller needs", async () => {
    const blockers = [{ kind: "SUPPORT_ADMIN" }];
    mockGetBlockers.mockResolvedValue(blockers);
    mockGetConfirmation.mockResolvedValue("recent-sign-in");
    const { req, res } = makeReqRes();

    await handleGetMyDeletion(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      canDelete: false,
      blockers,
      confirmation: "recent-sign-in",
    });
  });

  describe("a user with a password", () => {
    beforeEach(() => mockGetHash.mockResolvedValue("stored-hash"));

    it("refuses a missing password without checking anything else", async () => {
      const { req, res } = deleteRequest();

      expect(await refusalOf(handlePostDeleteMe(req, res))).toEqual({
        code: 403,
        reason: "PASSWORD_INVALID",
      });
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockDeleteAccount).not.toHaveBeenCalled();
    });

    it("refuses a wrong password", async () => {
      mockVerify.mockResolvedValue(false);
      const { req, res } = deleteRequest({ password: "wrong" });

      expect(await refusalOf(handlePostDeleteMe(req, res))).toEqual({
        code: 403,
        reason: "PASSWORD_INVALID",
      });
      expect(mockVerify).toHaveBeenCalledWith({ hash: "stored-hash", password: "wrong" });
      expect(mockDeleteAccount).not.toHaveBeenCalled();
    });

    it("still needs the password when the session is brand new", async () => {
      mockGetSessionCreatedAt.mockResolvedValue(new Date());
      const { req, res } = deleteRequest();

      expect((await refusalOf(handlePostDeleteMe(req, res))).reason).toBe("PASSWORD_INVALID");
    });

    it("deletes on the right password, answers 204 and expires the session cookies", async () => {
      mockVerify.mockResolvedValue(true);
      const { req, res } = deleteRequest({ password: "right" });

      await handlePostDeleteMe(req, res);

      expect(mockDeleteAccount).toHaveBeenCalledWith(mockAuthData.userId, TX);
      expect(mockRemoveObjects).toHaveBeenCalledWith(mockAuthData.userId, []);
      expect(res.status).toHaveBeenCalledWith(204);
      const cleared = (res as unknown as { clearCookie: ReturnType<typeof vi.fn> }).clearCookie.mock
        .calls;
      expect(cleared.map(([name]) => name)).toEqual([
        "better-auth.session_token",
        "better-auth.session_data",
        "better-auth.dont_remember",
      ]);
      expect(cleared[0]?.[1]).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax" });
    });

    it("passes a blocked deletion's 409 through untouched", async () => {
      mockVerify.mockResolvedValue(true);
      const blocked = new AppError({ code: 409, publicContext: { reason: "DELETION_BLOCKED" } });
      mockDeleteAccount.mockRejectedValue(blocked);
      const { req, res } = deleteRequest({ password: "right" });

      await expect(handlePostDeleteMe(req, res)).rejects.toBe(blocked);
      expect(mockRemoveObjects).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("a social-only user", () => {
    beforeEach(() => mockGetHash.mockResolvedValue(null));

    it("deletes without a password when the session is under a day old", async () => {
      mockGetSessionCreatedAt.mockResolvedValue(new Date(Date.now() - 23 * HOUR_MS));
      const { req, res } = deleteRequest();

      await handlePostDeleteMe(req, res);

      expect(mockGetSessionCreatedAt).toHaveBeenCalledWith(mockAuthData.sessionId);
      expect(mockDeleteAccount).toHaveBeenCalledWith(mockAuthData.userId, TX);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it("asks for a new sign-in when the session is over a day old, password or not", async () => {
      mockGetSessionCreatedAt.mockResolvedValue(new Date(Date.now() - 25 * HOUR_MS));
      const { req, res } = deleteRequest({ password: "anything" });

      expect(await refusalOf(handlePostDeleteMe(req, res))).toEqual({
        code: 403,
        reason: "REAUTH_REQUIRED",
      });
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockDeleteAccount).not.toHaveBeenCalled();
    });
  });
});
