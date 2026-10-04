import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { assertNativeSession } from "../../utils/nativeSession.js";
import { storeAppleAuthorization } from "../../services/appleAuthorization/appleAuthorizationServices.js";
import {
  AppleAuthorizationRefusal,
  type PostAppleAuthorizationBody,
} from "../../services/appleAuthorization/types.js";

const REFUSALS: Record<AppleAuthorizationRefusal, { code: number; message: string }> = {
  [AppleAuthorizationRefusal.AccountMissing]: { code: 409, message: "No Apple account is linked" },
  [AppleAuthorizationRefusal.ExchangeFailed]: {
    code: 502,
    message: "Apple did not accept the authorization code",
  },
  [AppleAuthorizationRefusal.SubjectMismatch]: {
    code: 409,
    message: "The authorization belongs to another Apple account",
  },
};

export const handlePostAppleAuthorization = async (req: Request, res: Response) => {
  const session = getAuth(req);
  assertNativeSession(session);
  const { authorizationCode } = req.body as PostAppleAuthorizationBody;

  const outcome = await storeAppleAuthorization(session.userId, authorizationCode);
  if (!outcome.stored) {
    const { code, message } = REFUSALS[outcome.refusal];
    throw new AppError({
      message,
      code,
      logging: true,
      context: { userId: session.userId },
      publicContext: { reason: outcome.refusal },
    });
  }
  return res.status(204).end();
};
