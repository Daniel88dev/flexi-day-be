import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../utils/auth.js";
import { logger } from "./logger.js";
import AppError from "../utils/appError.js";

export type AuthSession = {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  emailVerified: boolean;
};

export const authSession = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      return next(
        new AppError({ message: "Unauthorized", code: 401, logging: true })
      );
    }
    req.auth = {
      sessionId: session.session.id,
      userId: session.user.id,
      userName: session.user.name,
      userEmail: session.user.email,
      emailVerified: session.user.emailVerified,
    } as AuthSession;
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
