import type { NextFunction, Request, Response } from "express";
import AppError from "../utils/appError.js";
import { assertNativeSession } from "../utils/nativeSession.js";

/** Ahead of body validation, so a web session gets 403 whatever it sends. */
export const requireNativeSession = (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!req.auth) throw new AppError({ message: "Unauthorized", logging: true, code: 401 });
    assertNativeSession(req.auth);
    next();
  } catch (error) {
    next(error);
  }
};
