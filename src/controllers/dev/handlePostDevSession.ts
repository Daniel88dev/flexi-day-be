import type { Request, Response } from "express";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { findUserByEmail } from "../../services/dev/devSeedServices.js";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  signSessionToken,
} from "../../utils/devSession.js";

export const validatePostDevSession = z.object({
  email: z.email(),
});

export type ValidatedPostDevSessionType = z.infer<typeof validatePostDevSession>;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Signs the caller in as an existing local user: sets the session cookie on the
 * response (the browser path) and returns the same value in the body (the
 * cookie-injection path for a test driver).
 */
export const handlePostDevSession = async (req: Request, res: Response) => {
  const { email } = req.body as ValidatedPostDevSessionType;

  const found = await findUserByEmail(email);
  if (!found) {
    throw new AppError({
      message: "No such user in the local database",
      code: 404,
      publicContext: { email },
    });
  }

  const token = await createSessionToken(found.id);
  const signed = signSessionToken(token);

  res.cookie(SESSION_COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
    // Raw value: better-auth reads the cookie unencoded, and percent-encoding
    // the base64 signature would break verification.
    encode: (value) => value,
  });

  return res.status(200).json({
    user: { id: found.id, email: found.email, name: found.name },
    cookieName: SESSION_COOKIE_NAME,
    cookieValue: signed,
    cookieHeader: `${SESSION_COOKIE_NAME}=${signed}`,
  });
};
