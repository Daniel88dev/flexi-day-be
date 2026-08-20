import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/db.js";
import { user } from "../db/schema/auth-schema.js";
import { recordSupportAccess } from "../services/support/supportServices.js";
import AppError from "../utils/appError.js";
import { logger } from "./logger.js";

/**
 * Gate for `/api/support/*`. The router is only mounted when `config.support`
 * exists, so this is the second line of defence rather than the first. Runs
 * after `authSession`.
 *
 * Non-allowlisted callers get a 404, not a 403 — the `supportAdmin` flag in
 * the session payload is the only thing a normal user ever sees of this
 * surface, and a probing one learns nothing from the response.
 *
 * The 2FA requirement is on the account, not the session: this surface reads
 * every customer's data, so a password alone must not open it. Checked per
 * request rather than cached — support traffic is a handful of requests.
 */
export const requireSupportAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    // Not `getAuth` from authSession.js: that module imports the whole
    // better-auth graph, and this guard needs only the already-populated
    // `req.auth`.
    const auth = req.auth;
    if (!auth) {
      return next(new AppError({ message: "Unauthorized", code: 401, logging: true }));
    }

    if (!config.support?.userIds.includes(auth.userId)) {
      logger.warn("supportGuard rejected non-allowlisted request", {
        userId: auth.userId,
        path: req.originalUrl,
      });
      return next(new AppError({ message: "Not found", code: 404 }));
    }

    const [row] = await db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, auth.userId))
      .limit(1);

    if (!row?.twoFactorEnabled) {
      return next(
        new AppError({
          message: "Two-factor authentication is required for support access",
          code: 403,
          logging: true,
          context: { userId: auth.userId },
        })
      );
    }

    // Before the handler, so even a request that later fails is on record.
    await recordSupportAccess({
      userId: auth.userId,
      method: req.method,
      path: req.originalUrl,
    });

    return next();
  } catch (err) {
    return next(err);
  }
};
