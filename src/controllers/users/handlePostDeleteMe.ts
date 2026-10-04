import type { Request, Response } from "express";
import { getAuth, type AuthSession } from "../../middleware/authSession.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";
import { appleClient, auth as betterAuth } from "../../utils/auth.js";
import { db } from "../../db/db.js";
import {
  deleteAccountRows,
  getCredentialPasswordHash,
  getSessionCreatedAt,
  removeAttachmentObjects,
} from "../../services/accountDeletion/accountDeletionServices.js";
import { collectAppleRevocations } from "../../services/appleAuthorization/appleAuthorizationServices.js";
import { revokeAtApple } from "../../services/appleAuthorization/appleRevocation.js";
import {
  DeletionRefusal,
  FRESH_SIGN_IN_MS,
  type PostDeleteMeBody,
} from "../../services/accountDeletion/types.js";

const refuse = (reason: DeletionRefusal, message: string, userId: string) =>
  new AppError({
    message,
    code: 403,
    logging: true,
    context: { userId },
    publicContext: { reason },
  });

const assertConfirmed = async (session: AuthSession, password: string | undefined) => {
  const hash = await getCredentialPasswordHash(session.userId);

  if (hash) {
    const context = await betterAuth.$context;
    const valid = await context.password.verify({ hash, password: password ?? "" });
    if (!valid) {
      throw refuse(DeletionRefusal.PasswordInvalid, "The password is not correct", session.userId);
    }
    return;
  }

  const createdAt = await getSessionCreatedAt(session.sessionId);
  if (!createdAt || Date.now() - createdAt.getTime() > FRESH_SIGN_IN_MS) {
    throw refuse(
      DeletionRefusal.ReauthRequired,
      "Sign in again to delete the account",
      session.userId
    );
  }
};

const clearSessionCookies = async (res: Response) => {
  const { authCookies } = await betterAuth.$context;
  for (const cookie of [
    authCookies.sessionToken,
    authCookies.sessionData,
    authCookies.dontRememberToken,
  ]) {
    const { secure, sameSite, path, domain, httpOnly } = cookie.attributes;
    res.clearCookie(cookie.name, {
      secure,
      path: path ?? "/",
      domain,
      httpOnly,
      sameSite:
        typeof sameSite === "string"
          ? (sameSite.toLowerCase() as "lax" | "strict" | "none")
          : sameSite,
    });
  }
};

export const handlePostDeleteMe = async (req: Request, res: Response) => {
  const session = getAuth(req);
  const { password } = req.body as PostDeleteMeBody;

  await assertConfirmed(session, password);

  const appleRevocations = await collectAppleRevocations(session.userId);
  const deleted = await db.transaction((tx) => deleteAccountRows(session.userId, tx));
  await removeAttachmentObjects(session.userId, deleted.attachments);
  await revokeAtApple(appleClient, session.userId, appleRevocations);
  logger.info("account deleted", {
    userId: session.userId,
    groups: deleted.groups,
    organizations: deleted.organizations,
    attachments: deleted.attachments.length,
    appleLinks: appleRevocations.length,
  });

  await clearSessionCookies(res);
  return res.status(204).end();
};
