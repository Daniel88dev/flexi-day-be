import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import * as Sentry from "@sentry/node";
import { auth } from "../utils/auth.js";
import { logger } from "./logger.js";
import AppError from "../utils/appError.js";
import { updateRequestContext } from "../utils/requestStore.js";
import {
  SESSION_DEVICE_MISMATCH,
  SESSION_DEVICE_MISMATCH_MESSAGE,
  isDeviceMismatchError,
} from "../utils/nativeSession.js";

export type AuthSession = {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  emailVerified: boolean;
};

export const authSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      return next(new AppError({ message: "Unauthorized", code: 401, logging: true }));
    }
    req.auth = {
      sessionId: session.session.id,
      userId: session.user.id,
      userName: session.user.name,
      userEmail: session.user.email,
      emailVerified: Boolean(session.user.emailVerified),
    };
    // Id only — name and email deliberately stay out of Sentry.
    Sentry.setUser({ id: session.user.id });
    Sentry.setAttributes({ "session.id": session.session.id });
    updateRequestContext({ userId: session.user.id });
    next();
  } catch (err) {
    // The device check runs inside better-auth, so it arrives as a rejected
    // `auth.api` call rather than a response, and `errorMiddleware` would
    // otherwise answer 500 for what is a 401 the phone has to recognise.
    // `logging: false` because the hook already logged the warning.
    if (isDeviceMismatchError(err)) {
      return next(
        new AppError({
          message: SESSION_DEVICE_MISMATCH_MESSAGE,
          code: 401,
          logging: false,
          publicContext: { code: SESSION_DEVICE_MISMATCH },
        })
      );
    }
    logger.error("authSession", { error: err });
    return next(err);
  }
};

export const getAuth = (req: Request): AuthSession => {
  if (!req.auth) {
    throw new AppError({ message: "Unauthorized", logging: true, code: 401 });
  }

  return req.auth;
};
