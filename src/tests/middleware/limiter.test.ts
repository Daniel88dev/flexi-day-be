/**
 * Unit tests for the rate limiters.
 * Test library/framework: Vitest
 */
import { describe, it, expect, onTestFinished } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import {
  apiFailureLimiter,
  apiLimiter,
  calendarFeedLimiter,
  CREDENTIAL_GUESSING_PATHS,
  credentialsLimiter,
  floodLimiter,
  otpSendKey,
} from "../../middleware/limiter.js";
import { listenOnLoopback } from "../loopbackServer.js";

async function appWith(mount: (app: Express) => void): Promise<string> {
  const app = express();
  app.set("trust proxy", 1);
  mount(app);
  const { url, close } = await listenOnLoopback(app);
  onTestFinished(close);
  return url;
}

/**
 * Stands in for `authSession`: only a request carrying the magic cookie counts
 * as validated, so a forged one reaches the limiter with no `req.auth` — the
 * case that must not mint its own bucket.
 */
const fakeAuthSession =
  (validCookie: string, userId: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.cookie === validCookie) {
      req.auth = {
        sessionId: "sess-1",
        userId,
        userName: "Test",
        userEmail: "test@dev.local",
        emailVerified: true,
      };
      return next();
    }
    res.status(401).json({ error: "Unauthorized" });
  };

/** Drive one key up to (and past) its allowance without waiting for the window. */
async function hammer(
  url: string,
  path: string,
  times: number,
  headers: Record<string, string>,
  method: "get" | "post" = "get"
) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await request(url)[method](path).set(headers);
    statuses.push(res.status);
  }
  return statuses;
}

describe("floodLimiter", () => {
  it("does not count preflights or the health check", async () => {
    const url = await appWith((a) => {
      a.use(floodLimiter);
      a.get("/health", (_, res) => res.status(200).json({ ok: true }));
      a.options("/api/vacation", (_, res) => res.status(204).end());
    });

    const health = await request(url).get("/health");
    expect(health.status).toBe(200);
    expect(health.headers["ratelimit-remaining"]).toBeUndefined();

    const preflight = await request(url).options("/api/vacation");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["ratelimit-remaining"]).toBeUndefined();
  });

  it("counts ordinary requests", async () => {
    const url = await appWith((a) => {
      a.use(floodLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const res = await request(url).get("/api/thing");
    expect(res.status).toBe(200);
    expect(Number(res.headers["ratelimit-remaining"])).toBeLessThan(5000);
  });
});

describe("apiLimiter", () => {
  /** Mirrors the real mount order: failure bound, session validation, per-user budget. */
  const apiApp = (userId: string, validCookie = "session=real") =>
    appWith((a) => {
      a.use("/api", fakeAuthSession(validCookie, userId), apiLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

  it("gives two users on the same IP separate budgets", async () => {
    const alice = await apiApp("user-alice");
    const bob = await apiApp("user-bob");

    const first = await request(alice).get("/api/thing").set("Cookie", "session=real");
    const second = await request(bob).get("/api/thing").set("Cookie", "session=real");

    // Both are the first request against their own key.
    expect(first.headers["ratelimit-remaining"]).toBe(second.headers["ratelimit-remaining"]);
  });

  it("shares one budget across a user's requests", async () => {
    const url = await apiApp("user-carol");

    const first = await request(url).get("/api/thing").set("Cookie", "session=real");
    const second = await request(url).get("/api/thing").set("Cookie", "session=real");

    expect(Number(second.headers["ratelimit-remaining"])).toBe(
      Number(first.headers["ratelimit-remaining"]) - 1
    );
  });

  it("never reaches the per-user budget for a forged session cookie", async () => {
    const url = await apiApp("user-dave");

    const forged = await request(url).get("/api/thing").set("Cookie", "session=forged");

    // Rejected at validation, so it cannot mint itself a fresh bucket.
    expect(forged.status).toBe(401);
    expect(forged.headers["ratelimit-remaining"]).toBeUndefined();
  });
});

describe("apiFailureLimiter", () => {
  it("does not spend the budget on requests that succeed", async () => {
    const url = await appWith((a) => {
      a.use(apiFailureLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const statuses = await hammer(url, "/api/thing", 120, { "X-Forwarded-For": "203.0.113.20" });

    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("cuts off cookie rotation well before the flood ceiling", async () => {
    const url = await appWith((a) => {
      a.use("/api", apiFailureLimiter, fakeAuthSession("session=real", "user-eve"));
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const statuses: number[] = [];
    for (let i = 0; i < 102; i++) {
      // A different invented cookie every time — the bypass this bound closes.
      const res = await request(url)
        .get("/api/thing")
        .set("X-Forwarded-For", "203.0.113.21")
        .set("Cookie", `session=forged-${i}`);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 100).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  const failureApp = (userId: string) =>
    appWith((a) => {
      a.use("/api", apiFailureLimiter, fakeAuthSession("session=real", userId));
      a.get("/api/forbidden", (_, res) => res.status(403).json({ error: "Forbidden" }));
      a.get("/api/missing", (_, res) => res.status(404).json({ error: "Not found" }));
      a.get("/api/conflict", (_, res) => res.status(409).json({ error: "Conflict" }));
      a.get("/api/broken", (_, res) => res.status(500).json({ error: "Broken" }));
      a.get("/api/limited", (_, res) => res.status(429).json({ error: "Too many requests" }));
    });

  it("never spends the budget on refusals to a validated session", async () => {
    const url = await failureApp("user-frank");
    const paths = [
      "/api/forbidden",
      "/api/missing",
      "/api/conflict",
      "/api/broken",
      "/api/limited",
    ];

    const statuses: number[] = [];
    for (let i = 0; i < 120; i++) {
      const res = await request(url)
        .get(paths[i % paths.length]!)
        .set("X-Forwarded-For", "203.0.113.22")
        .set("Cookie", "session=real");
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429)).toHaveLength(120 / paths.length);
  });

  it("counts a rejected session but not a validated session's 4xx", async () => {
    const url = await failureApp("user-grace");
    const remaining = async (path: string, cookie: string) => {
      const res = await request(url)
        .get(path)
        .set("X-Forwarded-For", "203.0.113.23")
        .set("Cookie", cookie);
      return Number(res.headers["ratelimit-remaining"]);
    };

    const first = await remaining("/api/missing", "session=real");
    const afterValidated = await remaining("/api/forbidden", "session=real");
    expect(afterValidated).toBe(first);

    await remaining("/api/missing", "session=forged");
    const afterRejected = await remaining("/api/missing", "session=real");
    expect(afterRejected).toBe(first - 1);
  });
});

describe("credentialsLimiter", () => {
  it("does not spend the budget on successful sign-ins", async () => {
    const url = await appWith((a) => {
      a.use(credentialsLimiter);
      a.get("/api/auth/sign-in", (_, res) => res.status(200).json({ ok: true }));
    });

    const statuses = await hammer(url, "/api/auth/sign-in", 25, {
      "X-Forwarded-For": "203.0.113.10",
    });

    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("locks out after 20 failed attempts from one IP", async () => {
    const url = await appWith((a) => {
      a.use(credentialsLimiter);
      a.get("/api/auth/sign-in", (_, res) => res.status(401).json({ error: "nope" }));
    });

    const statuses = await hammer(url, "/api/auth/sign-in", 22, {
      "X-Forwarded-For": "203.0.113.11",
    });

    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("returns the shared error body when it trips", async () => {
    const url = await appWith((a) => {
      a.use(credentialsLimiter);
      a.get("/api/auth/sign-in", (_, res) => res.status(401).json({ error: "nope" }));
    });

    await hammer(url, "/api/auth/sign-in", 20, { "X-Forwarded-For": "203.0.113.12" });
    const blocked = await request(url)
      .get("/api/auth/sign-in")
      .set("X-Forwarded-For", "203.0.113.12");

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too many requests");
  });
});

describe("account deletion behind the credential budget", () => {
  // Layered like `server.ts`, so the signed-in limiters in front of the route
  // cannot stand in for the credential budget.
  const deletionApp = (userId: string) =>
    appWith((a) => {
      a.use(CREDENTIAL_GUESSING_PATHS, credentialsLimiter);
      a.use("/api", apiFailureLimiter, fakeAuthSession("session=real", userId), apiLimiter);
      a.post("/api/users/me/delete", (req, res) => {
        if (req.headers["x-password"] === "right") return res.status(204).end();
        res.status(403).json({ errors: [{ context: { reason: "PASSWORD_INVALID" } }] });
      });
      a.get("/api/users/me/deletion", (_, res) => res.status(403).json({ error: "Forbidden" }));
      a.get("/api/users/me/settings", (_, res) => res.status(403).json({ error: "Forbidden" }));
    });

  const deleteTimes = (url: string, times: number, ip: string, password: string) =>
    hammer(
      url,
      "/api/users/me/delete",
      times,
      { "X-Forwarded-For": ip, Cookie: "session=real", "X-Password": password },
      "post"
    );

  it("cuts off a signed-in caller's wrong passwords after 20 failures from one IP", async () => {
    const url = await deletionApp("user-ivan");

    const statuses = await deleteTimes(url, 22, "203.0.113.30", "wrong");

    expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it("does not spend the budget on a successful deletion", async () => {
    const url = await deletionApp("user-judy");

    const statuses = await deleteTimes(url, 25, "203.0.113.31", "right");

    expect(statuses.every((s) => s === 204)).toBe(true);
  });

  it("leaves the deletion status and the other users routes outside the budget", async () => {
    const url = await deletionApp("user-karl");

    const headers = { "X-Forwarded-For": "203.0.113.32", Cookie: "session=real" };
    const statuses = [
      ...(await hammer(url, "/api/users/me/deletion", 25, headers)),
      ...(await hammer(url, "/api/users/me/settings", 25, headers)),
    ];

    expect(statuses.every((s) => s === 403)).toBe(true);
  });
});

describe("calendarFeedLimiter", () => {
  it("keys on the feed token, not the polling IP", async () => {
    const url = await appWith((a) => {
      a.get("/calendars/:token.ics", calendarFeedLimiter, (_, res) =>
        res.status(200).send("BEGIN")
      );
    });

    // One provider polling two users' feeds from the same address.
    const first = await request(url)
      .get("/calendars/tok-a.ics")
      .set("X-Forwarded-For", "66.102.0.1");
    const second = await request(url)
      .get("/calendars/tok-b.ics")
      .set("X-Forwarded-For", "66.102.0.1");

    expect(first.headers["ratelimit-remaining"]).toBe(second.headers["ratelimit-remaining"]);
  });

  it("shares a budget across repeat polls of one feed", async () => {
    const url = await appWith((a) => {
      a.get("/calendars/:token.ics", calendarFeedLimiter, (_, res) =>
        res.status(200).send("BEGIN")
      );
    });

    const first = await request(url).get("/calendars/tok-c.ics");
    const second = await request(url).get("/calendars/tok-c.ics");

    expect(Number(second.headers["ratelimit-remaining"])).toBe(
      Number(first.headers["ratelimit-remaining"]) - 1
    );
  });
});

describe("CREDENTIAL_GUESSING_PATHS", () => {
  it("keeps the whole two-factor surface behind credentialsLimiter", () => {
    // Not just the verify endpoints: enable / disable / get-totp-uri /
    // generate-backup-codes are password oracles, and without the
    // failures-only budget a stolen session cookie could brute-force the
    // password via POST /two-factor/disable and switch 2FA off.
    expect(CREDENTIAL_GUESSING_PATHS).toContain("/api/auth/two-factor");
  });

  it("keeps the invite link endpoints behind the same budget as sign-in", () => {
    expect(CREDENTIAL_GUESSING_PATHS).toContain("/api/auth/invite");
  });

  it("keeps the account-deletion password check behind the same budget as sign-in", () => {
    expect(CREDENTIAL_GUESSING_PATHS).toContain("/api/users/me/delete");
  });

  it("keeps the original credential endpoints covered", () => {
    expect(CREDENTIAL_GUESSING_PATHS).toEqual(
      expect.arrayContaining([
        "/api/auth/sign-in",
        "/api/auth/sign-up",
        "/api/auth/sign-up-with-team",
        "/api/auth/reset-password",
      ])
    );
  });
});

describe("otpSendKey", () => {
  const reqWith = (cookie?: string, ip = "203.0.113.7") =>
    ({ headers: cookie ? { cookie } : {}, ip }) as unknown as Request;

  it("keys on the challenge cookie, so an office NAT never pools", () => {
    const a = otpSendKey(reqWith("better-auth.two_factor=challenge-a"));
    const b = otpSendKey(reqWith("better-auth.two_factor=challenge-b"));
    expect(a).not.toBe(b);
    expect(a.startsWith("otp:")).toBe(true);
  });

  it("gives the same challenge the same bucket across IPs", () => {
    const a = otpSendKey(reqWith("better-auth.two_factor=challenge-a", "203.0.113.7"));
    const b = otpSendKey(reqWith("better-auth.two_factor=challenge-a", "198.51.100.9"));
    expect(a).toBe(b);
  });

  it("ignores unrelated cookies around the auth cookie", () => {
    const bare = otpSendKey(reqWith("better-auth.session_token=sess-1"));
    const noisy = otpSendKey(reqWith("theme=dark; better-auth.session_token=sess-1; foo=bar"));
    expect(noisy).toBe(bare);
  });

  it("accepts the production __Secure- cookie prefix", () => {
    const key = otpSendKey(reqWith("__Secure-better-auth.two_factor=challenge-a"));
    expect(key.startsWith("otp:")).toBe(true);
  });

  it("falls back to the IP when no auth cookie is present", () => {
    const key = otpSendKey(reqWith(undefined, "203.0.113.7"));
    expect(key.startsWith("otp:")).toBe(false);
  });
});
