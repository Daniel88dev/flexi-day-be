import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import * as Sentry from "@sentry/node";
import { auth } from "../utils/auth.js";
import { logger } from "./logger.js";
import AppError from "../utils/appError.js";
import { updateRequestContext } from "../utils/requestStore.js";

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
