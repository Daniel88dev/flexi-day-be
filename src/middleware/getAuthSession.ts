import { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../utils/auth.js";
import { logger } from "./logger.js";

export type AuthSession = {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  emailVerified: boolean;
};

export const getAuthSession = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
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
    logger.error("getAuthSession", { error: err });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
