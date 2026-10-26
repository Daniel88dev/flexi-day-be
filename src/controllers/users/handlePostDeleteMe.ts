import type { Request, Response } from "express";
import { getAuth, type AuthSession } from "../../middleware/authSession.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";
import { appleClient, auth as betterAuth } from "../../utils/auth.js";
import { db } from "../../db/db.js";
import {
  deleteAccountRows,
  getCredentialPasswordHash,
  getDeletionBlockers,
  getSessionCreatedAt,
  removeAttachmentObjects,
} from "../../services/accountDeletion/accountDeletionServices.js";
import { removeOrganizationExports } from "../../services/personExport/organizationExportServices.js";
import { disconnectAllProviders } from "../../services/calendarConnection/calendarConnectionServices.js";
import { collectAppleRevocations } from "../../services/appleAuthorization/appleAuthorizationServices.js";
import { revokeAtApple } from "../../services/appleAuthorization/appleRevocation.js";
import {
  planAccountDeletedNotices,
  sendAccountDeletedNotices,
} from "../../services/accountDeletion/accountDeletedNotice.js";
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

  // The calendar step needs the ledger and the tokens, which the transaction
  // deletes, so it runs before it and only when nothing blocks it.
  const calendarConnections =
    (await getDeletionBlockers(session.userId)).length === 0
      ? await disconnectAllProviders(session.userId)
      : 0;
  const appleRevocations = await collectAppleRevocations(session.userId);
  const deleted = await db.transaction(async (tx) => {
    const rows = await deleteAccountRows(session.userId, tx);
    const notices = await planAccountDeletedNotices(session.userId, rows.handedOverGroups, tx);
    return { ...rows, notices };
  });
  await sendAccountDeletedNotices(session.userId, deleted.notices);
  await removeAttachmentObjects(session.userId, deleted.attachments);
  await removeOrganizationExports(deleted.organizationIds);
  await revokeAtApple(appleClient, session.userId, appleRevocations);
  logger.info("account deleted", {
    userId: session.userId,
    groups: deleted.groups,
    handedOverGroups: deleted.handedOverGroups.length,
    organizations: deleted.organizations,
    cancelledRequests: deleted.cancelledRequests,
    notices: deleted.notices.length,
    attachments: deleted.attachments.length,
    appleLinks: appleRevocations.length,
    calendarConnections,
  });

  await clearSessionCookies(res);
  return res.status(204).end();
};
