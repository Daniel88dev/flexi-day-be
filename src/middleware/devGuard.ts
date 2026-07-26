import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import { config } from "../config.js";
import AppError from "../utils/appError.js";
import { logger } from "./logger.js";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const tokensMatch = (received: string, expected: string): boolean => {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Gate for `/api/dev/*`. The router is only mounted when `config.dev` exists,
 * so this is the second line of defence rather than the first.
 *
 * The peer is read off the socket instead of `req.ip` on purpose: `trust proxy`
 * is enabled, so `req.ip` follows a client-supplied `X-Forwarded-For` and would
 * be trivially spoofable. Non-loopback callers get a 404 — no hint that the
 * surface exists at all.
 */
export const devGuard = (req: Request, _res: Response, next: NextFunction) => {
  const dev = config.dev;
  if (!dev) {
    return next(new AppError({ message: "Not found", code: 404 }));
  }

  const peer = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_PEERS.has(peer)) {
    logger.warn("devGuard rejected non-loopback request", { peer, path: req.path });
    return next(new AppError({ message: "Not found", code: 404 }));
  }

  if (!tokensMatch(req.get("x-dev-token") ?? "", dev.token)) {
    return next(
      new AppError({ message: "Invalid dev token", code: 401, logging: true, context: { peer } })
    );
  }

  return next();
};
