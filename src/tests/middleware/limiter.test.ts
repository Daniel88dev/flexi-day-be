/**
 * Unit tests for the rate limiters.
 * Test library/framework: Vitest
 */
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import {
  apiFailureLimiter,
  apiLimiter,
  calendarFeedLimiter,
  credentialsLimiter,
  floodLimiter,
} from "../../middleware/limiter.js";

function appWith(mount: (app: Express) => void): Express {
  const app = express();
  app.set("trust proxy", 1);
  mount(app);
  return app;
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
async function hammer(app: Express, path: string, times: number, headers: Record<string, string>) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await request(app).get(path).set(headers);
    statuses.push(res.status);
  }
  return statuses;
}

describe("floodLimiter", () => {
  it("does not count preflights or the health check", async () => {
    const app = appWith((a) => {
      a.use(floodLimiter);
      a.get("/health", (_, res) => res.status(200).json({ ok: true }));
      a.options("/api/vacation", (_, res) => res.status(204).end());
    });

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.headers["ratelimit-remaining"]).toBeUndefined();

    const preflight = await request(app).options("/api/vacation");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["ratelimit-remaining"]).toBeUndefined();
  });

  it("counts ordinary requests", async () => {
    const app = appWith((a) => {
      a.use(floodLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const res = await request(app).get("/api/thing");
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
    const alice = apiApp("user-alice");
    const bob = apiApp("user-bob");

    const first = await request(alice).get("/api/thing").set("Cookie", "session=real");
    const second = await request(bob).get("/api/thing").set("Cookie", "session=real");

    // Both are the first request against their own key.
    expect(first.headers["ratelimit-remaining"]).toBe(second.headers["ratelimit-remaining"]);
  });

  it("shares one budget across a user's requests", async () => {
    const app = apiApp("user-carol");

    const first = await request(app).get("/api/thing").set("Cookie", "session=real");
    const second = await request(app).get("/api/thing").set("Cookie", "session=real");

    expect(Number(second.headers["ratelimit-remaining"])).toBe(
      Number(first.headers["ratelimit-remaining"]) - 1
    );
  });

  it("never reaches the per-user budget for a forged session cookie", async () => {
    const app = apiApp("user-dave");

    const forged = await request(app).get("/api/thing").set("Cookie", "session=forged");

    // Rejected at validation, so it cannot mint itself a fresh bucket.
    expect(forged.status).toBe(401);
    expect(forged.headers["ratelimit-remaining"]).toBeUndefined();
  });
});

describe("apiFailureLimiter", () => {
  it("does not spend the budget on requests that succeed", async () => {
    const app = appWith((a) => {
      a.use(apiFailureLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const statuses = await hammer(app, "/api/thing", 120, { "X-Forwarded-For": "203.0.113.20" });

    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("cuts off cookie rotation well before the flood ceiling", async () => {
    const app = appWith((a) => {
      a.use("/api", apiFailureLimiter, fakeAuthSession("session=real", "user-eve"));
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const statuses: number[] = [];
    for (let i = 0; i < 102; i++) {
      // A different invented cookie every time — the bypass this bound closes.
      const res = await request(app)
        .get("/api/thing")
        .set("X-Forwarded-For", "203.0.113.21")
        .set("Cookie", `session=forged-${i}`);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 100).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("credentialsLimiter", () => {
  it("does not spend the budget on successful sign-ins", async () => {
    const app = appWith((a) => {
      a.use(credentialsLimiter);
      a.get("/api/auth/sign-in", (_, res) => res.status(200).json({ ok: true }));
    });

    const statuses = await hammer(app, "/api/auth/sign-in", 25, {
      "X-Forwarded-For": "203.0.113.10",
    });

    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("locks out after 20 failed attempts from one IP", async () => {
    const app = appWith((a) => {
      a.use(credentialsLimiter);
      a.get("/api/auth/sign-in", (_, res) => res.status(401).json({ error: "nope" }));
    });

    const statuses = await hammer(app, "/api/auth/sign-in", 22, {
      "X-Forwarded-For": "203.0.113.11",
    });

    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("returns the shared error body when it trips", async () => {
    const app = appWith((a) => {
      a.use(credentialsLimiter);
      a.get("/api/auth/sign-in", (_, res) => res.status(401).json({ error: "nope" }));
    });

    await hammer(app, "/api/auth/sign-in", 20, { "X-Forwarded-For": "203.0.113.12" });
    const blocked = await request(app)
      .get("/api/auth/sign-in")
      .set("X-Forwarded-For", "203.0.113.12");

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too many requests");
  });
});

describe("calendarFeedLimiter", () => {
  it("keys on the feed token, not the polling IP", async () => {
    const app = appWith((a) => {
      a.get("/calendars/:token.ics", calendarFeedLimiter, (_, res) =>
        res.status(200).send("BEGIN")
      );
    });

    // One provider polling two users' feeds from the same address.
    const first = await request(app)
      .get("/calendars/tok-a.ics")
      .set("X-Forwarded-For", "66.102.0.1");
    const second = await request(app)
      .get("/calendars/tok-b.ics")
      .set("X-Forwarded-For", "66.102.0.1");

    expect(first.headers["ratelimit-remaining"]).toBe(second.headers["ratelimit-remaining"]);
  });

  it("shares a budget across repeat polls of one feed", async () => {
    const app = appWith((a) => {
      a.get("/calendars/:token.ics", calendarFeedLimiter, (_, res) =>
        res.status(200).send("BEGIN")
      );
    });

    const first = await request(app).get("/calendars/tok-c.ics");
    const second = await request(app).get("/calendars/tok-c.ics");

    expect(Number(second.headers["ratelimit-remaining"])).toBe(
      Number(first.headers["ratelimit-remaining"]) - 1
    );
  });
});
