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

/**
 * Middleware function `authSession` is responsible for verifying the user's authentication session.
 *
 * This function checks the incoming request for valid session data by interacting with the authentication API.
 * If a valid session is found, it populates the `req.auth` property with session-related details such as
 * session ID, user ID, username, user email, and email verification status.
 *
 * If no valid session is identified, or an error occurs during the process, it forwards the error using
 * the `next` function. When the session is invalid, an `AppError` with an appropriate message, status code,
 * and logging preference is returned.
 *
 * Errors are logged for tracking purposes in case of unexpected failures.
 *
 * @param {Request} req - The incoming request object containing headers for session verification.
 * @param {Response} res - The response object, unused in this middleware but passed as part of the signature.
 * @param {NextFunction} next - Function used to pass control to the next middleware or error handler.
 */
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

/**
 * Retrieves the authentication session from the provided request object.
 *
 * This function extracts the `auth` property from the incoming request.
 * If the `auth` property is not present, it throws an `AppError` indicating
 * an unauthorized access attempt with a 401 status code.
 *
 * @param {Request} req - The incoming request object containing the authentication information.
 * @returns {AuthSession} - The authentication session associated with the request.
 * @throws {AppError} - Throws an error if the request does not contain an `auth` property.
 */
export const getAuth = (req: Request): AuthSession => {
  if (!req.auth) {
    throw new AppError({ message: "Unauthorized", logging: true, code: 401 });
  }

  return req.auth;
};
