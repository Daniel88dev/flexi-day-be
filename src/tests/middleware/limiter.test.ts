/**
 * Unit tests for the rate limiters.
 * Test library/framework: Vitest
 */
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import {
  apiLimiter,
  calendarFeedLimiter,
  credentialsLimiter,
  floodLimiter,
} from "../../middleware/limiter.js";

const SESSION = "better-auth.session_token=abc.def";
const OTHER_SESSION = "better-auth.session_token=zzz.yyy";

function appWith(mount: (app: Express) => void): Express {
  const app = express();
  app.set("trust proxy", 1);
  mount(app);
  return app;
}

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
  it("gives two sessions from the same IP separate budgets", async () => {
    const app = appWith((a) => {
      a.use(apiLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const first = await request(app).get("/api/thing").set("Cookie", SESSION);
    const second = await request(app).get("/api/thing").set("Cookie", OTHER_SESSION);

    // Both are the first request against their own key.
    expect(first.headers["ratelimit-remaining"]).toBe(second.headers["ratelimit-remaining"]);
  });

  it("shares a budget across requests carrying the same session", async () => {
    const app = appWith((a) => {
      a.use(apiLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const first = await request(app).get("/api/thing").set("Cookie", SESSION);
    const second = await request(app).get("/api/thing").set("Cookie", SESSION);

    expect(Number(second.headers["ratelimit-remaining"])).toBe(
      Number(first.headers["ratelimit-remaining"]) - 1
    );
  });

  it("also matches the __Secure- prefixed cookie used over https", async () => {
    const app = appWith((a) => {
      a.use(apiLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const plain = await request(app).get("/api/thing").set("Cookie", SESSION);
    const secure = await request(app)
      .get("/api/thing")
      .set("Cookie", "__Secure-better-auth.session_token=abc.def");

    // Same token value, so the secure variant lands in the same bucket.
    expect(Number(secure.headers["ratelimit-remaining"])).toBe(
      Number(plain.headers["ratelimit-remaining"]) - 1
    );
  });

  it("falls back to the IP when there is no session cookie", async () => {
    const app = appWith((a) => {
      a.use(apiLimiter);
      a.get("/api/thing", (_, res) => res.status(200).json({ ok: true }));
    });

    const first = await request(app).get("/api/thing").set("X-Forwarded-For", "203.0.113.7");
    const second = await request(app).get("/api/thing").set("X-Forwarded-For", "203.0.113.7");

    expect(Number(second.headers["ratelimit-remaining"])).toBe(
      Number(first.headers["ratelimit-remaining"]) - 1
    );
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
