import { createHash } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { ipKeyGenerator, MemoryStore, rateLimit } from "express-rate-limit";

const FIVE_MINUTES = 5 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

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

export const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? "");

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
  // the health check must not spend a caller's budget. `/mcp` has limiters of
  // its own: every Claude user calls it from Anthropic's few egress addresses.
  skip: (req) =>
    req.method === "OPTIONS" ||
    req.path === "/health" ||
    req.path === "/mcp" ||
    req.path.startsWith("/mcp/"),
});

/**
 * Rejected `/api` traffic from callers without a validated session, counted
 * per IP ahead of session validation. A request that passed `authSession`
 * never counts, whatever it ends with, so a whole office's real requests never
 * touch it; signed-in traffic is bounded by `apiLimiter` alone. Unauthenticated
 * probing, and anyone rotating forged session cookies to mint fresh
 * `apiLimiter` buckets, is cut off long before the flood ceiling.
 *
 * The success rule runs when the response finishes, after `authSession` has
 * set `req.auth`, which is why it can see the session from in front of it.
 */
export const apiFailureLimiter = rateLimit({
  ...shared,
  windowMs: FIVE_MINUTES,
  limit: 100,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => req.auth !== undefined || res.statusCode < 400,
  keyGenerator: ipKey,
  skip: (req) => req.method === "OPTIONS",
});

/**
 * Authenticated API traffic, ~10 requests per page load, so this is ~100 loads.
 *
 * Keyed on the user id that `authSession` has already validated — never on the
 * raw cookie, which a caller can invent to hand itself an unused bucket. Keying
 * on the IP instead would pool every user behind one office NAT, VPN or mobile
 * CGNAT into a single allowance, which is what makes a shared limit feel
 * arbitrarily strict.
 */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: FIVE_MINUTES,
  limit: 1000,
  keyGenerator: (req) => (req.auth?.userId ? `u:${req.auth.userId}` : ipKey(req)),
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
 * Password-reset requests, which `credentialsLimiter` cannot cover: that one
 * sets `skipSuccessfulRequests`, and this endpoint answers 200 to every input
 * on purpose so it reveals nothing about which addresses exist. Nothing would
 * ever increment the counter.
 *
 * What needs bounding here is not guessing but sending: each accepted request
 * puts a real email in someone else's inbox and spends SES quota, so a loop
 * against one address is both harassment and cost. Low enough to make that
 * pointless, high enough for someone who genuinely mistypes and retries.
 *
 * Two limits worth knowing. It keys on the IP, so it bounds volume per source
 * and not per address — a flood from many sources at one address is still open.
 * And better-auth applies its own 3-per-60s rule to this route first, so this
 * is the longer-window ceiling rather than the burst control.
 */
export const passwordResetLimiter = rateLimit({
  ...shared,
  windowMs: FIFTEEN_MINUTES,
  limit: 5,
  keyGenerator: ipKey,
});

/**
 * Keys `send-otp` on the better-auth challenge (or session) cookie rather
 * than the IP: emailed-OTP sign-in is a routine per-user flow, so an IP key
 * would pool a whole office NAT into one budget — the exact pooling the
 * `apiLimiter` doctrine above rejects. The cookie value is stable for the
 * life of one challenge, and a request with no/invalid cookie sends no email
 * (the endpoint 401s), so invented cookies mint buckets that cost nothing.
 * Falls back to the IP when no auth cookie is present at all.
 */
export const otpSendKey = (req: Request): string => {
  const match = /(?:^|;\s*)(?:__Secure-)?better-auth\.(?:two_factor|session_token)=([^;]+)/.exec(
    req.headers.cookie ?? ""
  );
  if (!match) return ipKey(req);
  return `otp:${createHash("sha256").update(match[1]!).digest("base64")}`;
};

/**
 * Two-factor `send-otp`, uncoverable by `credentialsLimiter` for the same
 * reason as password reset: it answers 200 no matter what, so a
 * failures-only counter never increments, and the cost to bound is the email
 * it sends. The budget is per challenge/session (see `otpSendKey`), sized so
 * one sign-in can burn several codes (expiry is 3 minutes, plus resends).
 * The plugin's own 3-per-10s rule on `/two-factor/*` is the burst control.
 */
export const otpSendLimiter = rateLimit({
  ...shared,
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
  keyGenerator: otpSendKey,
});

/**
 * The auth endpoints where a wrong guess is the point, plus our own routes
 * that check a password, shared with `server.ts` and pinned by a guard test:
 * every path here fails with 4xx on a bad guess, so the failures-only
 * `credentialsLimiter` covers it. The two-factor prefix is deliberate
 * breadth — verify-* are a 6-digit guessing surface, and
 * enable/disable/get-totp-uri/generate-backup-codes are password oracles a
 * stolen session cookie must not get to brute-force.
 */
export const CREDENTIAL_GUESSING_PATHS = [
  "/api/auth/sign-in",
  "/api/auth/sign-up",
  "/api/auth/sign-up-with-team",
  // Covers the POST that spends the token. The GET at
  // `/reset-password/:token` prefix-matches too but is never counted: it
  // answers 302 either way, and this limiter skips anything under 400.
  "/api/auth/reset-password",
  "/api/auth/two-factor",
  // The invite link endpoints are public or near enough, and an unknown
  // secret answers 404, so a prober burns this budget like a password guesser.
  "/api/auth/invite",
  // Prefix matching is per segment, so `GET /api/users/me/deletion` stays outside.
  "/api/users/me/delete",
];

/**
 * Calendar clients subscribe with a token and no cookie, and Google polls every
 * subscribed feed from a handful of shared ranges — keying this on the IP would
 * make one popular provider throttle every user at once.
 */
export const calendarFeedLimiter = rateLimit({
  ...shared,
  windowMs: ONE_HOUR,
  limit: 120,
  keyGenerator: (req) =>
    typeof req.params.token === "string" && req.params.token ? `t:${req.params.token}` : ipKey(req),
});

/**
 * Signed webhooks (Paddle, Anthropic, the attachment processor's callback) carry no
 * session by design — the HMAC signature is the real gate — so this is only
 * a backstop against a garbage-blast doing signature work at flood volume.
 *
 * Deliberately far above any plausible legitimate burst. Paddle delivers from
 * a small fixed IP range, so every customer's events share one bucket; a
 * dunning run or a backlog replay must not hit it, because a 429 is a non-2xx
 * — Paddle retries, and sustained failures pause the notification destination
 * entirely, which would silently stop all subscription syncing.
 */
export const signedWebhookLimiter = rateLimit({
  ...shared,
  windowMs: FIVE_MINUTES,
  limit: 5000,
  keyGenerator: ipKey,
});

/**
 * Dynamic Client Registration across every address. The provider's own rule
 * bounds one address to 5 a minute; this is the ceiling a distributed flood of
 * registrations meets. Only registrations that succeed count.
 */
export const dcrDailyLimiter = rateLimit({
  ...shared,
  windowMs: ONE_DAY,
  limit: 1000,
  skipFailedRequests: true,
  keyGenerator: () => "oauth2-register",
});

/**
 * better-auth answers its own 429 with `X-Retry-After` only. Copies it to the
 * standard `Retry-After` before the head goes out.
 */
export const mirrorRetryAfter = (_req: Request, res: Response, next: NextFunction) => {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    const status = typeof args[0] === "number" ? args[0] : res.statusCode;
    const value = res.getHeader("x-retry-after");
    if (status === 429 && value !== undefined && !res.hasHeader("retry-after")) {
      res.setHeader("Retry-After", String(value));
    }
    return writeHead(...args);
  }) as Response["writeHead"];
  next();
};

export type BudgetHit = { allowed: boolean; resetAt: Date };

/**
 * A fixed-window counter outside the middleware chain, for limits decided
 * after the request is read (an MCP tool call, a token that failed to verify).
 * In memory, like every limiter here.
 */
export const windowBudget = ({ windowMs, limit }: { windowMs: number; limit: number }) => {
  const store = new MemoryStore();
  store.init({ windowMs } as Parameters<MemoryStore["init"]>[0]);
  return {
    limit,
    windowMs,
    hit: async (key: string): Promise<BudgetHit> => {
      const { totalHits, resetTime } = await store.increment(key);
      return {
        allowed: totalHits <= limit,
        resetAt: resetTime ?? new Date(Date.now() + windowMs),
      };
    },
    spent: async (key: string): Promise<boolean> => {
      const info = await store.get(key);
      return (info?.totalHits ?? 0) >= limit;
    },
    resetAt: async (key: string): Promise<Date> =>
      (await store.get(key))?.resetTime ?? new Date(Date.now() + windowMs),
  };
};

export type WindowBudget = ReturnType<typeof windowBudget>;

/**
 * `/mcp` requests from one address that carried no token or one that failed
 * verification. Once spent, only such requests are refused: a valid token
 * never is, because every Claude user shares a few Anthropic egress addresses.
 */
export const mcpUnauthBudget = windowBudget({ windowMs: FIVE_MINUTES, limit: 2000 });

/** Tool calls per user and OAuth client, every tool. */
export const mcpCallBudget = windowBudget({ windowMs: FIVE_MINUTES, limit: 300 });

/** Write-tool calls per user and OAuth client: each one can email approvers. */
export const mcpWriteBudget = windowBudget({ windowMs: ONE_HOUR, limit: 30 });
