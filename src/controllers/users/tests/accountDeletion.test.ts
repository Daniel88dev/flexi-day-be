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
  mockCollectApple,
  mockRevokeApple,
  APPLE_CLIENT,
} = vi.hoisted(() => ({
  mockGetBlockers: vi.fn(),
  mockGetConfirmation: vi.fn(),
  mockGetHash: vi.fn(),
  mockGetSessionCreatedAt: vi.fn(),
  mockDeleteAccount: vi.fn(),
  mockRemoveObjects: vi.fn(),
  mockVerify: vi.fn(),
  mockCollectApple: vi.fn(),
  mockRevokeApple: vi.fn(),
  APPLE_CLIENT: { stand: "in for the Apple client" },
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

vi.mock("../../../services/appleAuthorization/appleAuthorizationServices.js", () => ({
  collectAppleRevocations: mockCollectApple,
}));

vi.mock("../../../services/appleAuthorization/appleRevocation.js", () => ({
  revokeAtApple: mockRevokeApple,
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
    appleClient: APPLE_CLIENT,
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

const APPLE_REVOCATIONS = [
  { linkId: "account-row-1", audience: "com.flexiday.app", refreshToken: "apple-refresh-token" },
];

const firstCall = (mock: ReturnType<typeof vi.fn>) => mock.mock.invocationCallOrder[0] ?? -1;

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
    mockCollectApple.mockResolvedValue(APPLE_REVOCATIONS);
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

    it("refuses a missing password", async () => {
      mockVerify.mockResolvedValue(false);
      const { req, res } = deleteRequest();

      expect(await refusalOf(handlePostDeleteMe(req, res))).toEqual({
        code: 403,
        reason: "PASSWORD_INVALID",
      });
      expect(mockVerify).toHaveBeenCalledWith({ hash: "stored-hash", password: "" });
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
      mockVerify.mockResolvedValue(false);
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
      expect(mockRevokeApple).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("collects the Apple links before the transaction and revokes them after the commit", async () => {
      mockVerify.mockResolvedValue(true);
      const { req, res } = deleteRequest({ password: "right" });

      await handlePostDeleteMe(req, res);

      expect(mockCollectApple).toHaveBeenCalledWith(mockAuthData.userId);
      expect(mockRevokeApple).toHaveBeenCalledTimes(1);
      expect(mockRevokeApple).toHaveBeenCalledWith(
        APPLE_CLIENT,
        mockAuthData.userId,
        APPLE_REVOCATIONS
      );
      expect(firstCall(mockCollectApple)).toBeLessThan(firstCall(mockDeleteAccount));
      expect(firstCall(mockDeleteAccount)).toBeLessThan(firstCall(mockRevokeApple));
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it("revokes nothing at Apple when the password is refused", async () => {
      mockVerify.mockResolvedValue(false);
      const { req, res } = deleteRequest({ password: "wrong" });

      await expect(handlePostDeleteMe(req, res)).rejects.toBeInstanceOf(AppError);
      expect(mockCollectApple).not.toHaveBeenCalled();
      expect(mockRevokeApple).not.toHaveBeenCalled();
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
      expect(mockRevokeApple).not.toHaveBeenCalled();
    });
  });
});
