import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const FIVE_MINUTES = 5 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const shared = {
  statusCode: 429,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many requests",
      retryAfter: res.getHeader("Retry-After") ?? undefined,
    });
  },
} as const;

const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? "");

/**
 * Bucket authenticated traffic per session rather than per IP. Keying on the
 * IP pools every user behind one office NAT, VPN or mobile CGNAT into a single
 * allowance, which is what makes a shared limit feel arbitrarily strict.
 */
function sessionKey(req: Request): string | null {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  const match = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]*)/.exec(cookies);
  if (!match?.[1]) return null;
  return `s:${createHash("sha256").update(match[1]).digest("hex").slice(0, 32)}`;
}

/**
 * Outermost backstop against floods. Deliberately far above anything a real
 * client produces — the per-session and per-credential limits below are what
 * actually shape traffic.
 */
export const floodLimiter = rateLimit({
  ...shared,
  windowMs: FIVE_MINUTES,
  limit: 5000,
  keyGenerator: ipKey,
  // Preflights are not attack surface (CORS `maxAge` already caches them) and
  // the health check must not spend a caller's budget.
  skip: (req) => req.method === "OPTIONS" || req.path === "/health",
});

/** Authenticated API traffic. ~10 requests per page load, so this is ~100 loads. */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: FIVE_MINUTES,
  limit: 1000,
  keyGenerator: (req) => sessionKey(req) ?? ipKey(req),
  skip: (req) => req.method === "OPTIONS",
});

/**
 * The credential surface, where brute force actually costs something. Only
 * failures count, so a whole office signing in at 9am is unaffected while a
 * guesser burns the budget.
 */
export const credentialsLimiter = rateLimit({
  ...shared,
  windowMs: FIFTEEN_MINUTES,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: ipKey,
});

/**
 * Calendar clients subscribe with a token and no cookie, and Google polls every
 * subscribed feed from a handful of shared ranges — keying this on the IP would
 * make one popular provider throttle every user at once.
 */
export const calendarFeedLimiter = rateLimit({
  ...shared,
  windowMs: ONE_HOUR,
  limit: 120,
  keyGenerator: (req) => (req.params.token ? `t:${req.params.token}` : ipKey(req)),
});
