/**
 * The dev sign-in ticket's redeem endpoint lives on better-auth, not on the
 * gated `/api/dev` router, so it needs its own proof that it only exists when
 * the dev tools do.
 */
import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest";
import request from "supertest";
import { listenOnLoopback } from "./loopbackServer.js";

vi.mock("../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const TOKEN = "local-dev-token-0123456789";
const REDEEM_PATH = "/api/auth/dev/redeem-sign-in-ticket";

const ORIGINAL_ENV = { ...process.env };

// Every dev var is pinned: config.ts calls dotenv, which would otherwise fill
// unset ones in from the developer's own `.env`.
const BASE = {
  PORT: "8080",
  NODE_ENV: "test",
  DATABASE: "postgres://localhost:5432/flexi-day",
  BETTER_AUTH_SECRET: "secret-secret-secret-secret-secret",
  BETTER_AUTH_URL: "http://localhost:8080",
  TRUSTED_ORIGINS: "http://localhost:3000,flexiday://",
  DEV_TOOLS_ENABLED: "false",
  DEV_TOOLS_TOKEN: "",
  DEV_SEED_EMAIL_DOMAIN: "dev.local",
};

/** Config and auth are evaluated once at import, so each case needs a fresh module graph. */
const loadServer = async (env: Record<string, string>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const { createServer } = await import("../server.js");
  const { url, close } = await listenOnLoopback(createServer());
  onTestFinished(close);
  return url;
};

// No device id: the endpoint refuses before it reads the ticket or the
// database, so its answer tells a mounted endpoint from a missing one.
const redeemWithoutDevice = async (env: Record<string, string>) =>
  request(await loadServer(env))
    .post(REDEEM_PATH)
    .set("expo-origin", "flexiday://")
    .send({ ticket: "any" });

// A fresh import of the whole server per case is slow on a cold transform cache.
describe("dev sign-in ticket redeem endpoint", { timeout: 30_000 }, () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("does not exist while dev tools are off", async () => {
    const res = await redeemWithoutDevice(BASE);
    expect(res.status).toBe(404);
  });

  it("exists once dev tools are on", async () => {
    const res = await redeemWithoutDevice({
      ...BASE,
      DEV_TOOLS_ENABLED: "true",
      DEV_TOOLS_TOKEN: TOKEN,
    });
    expect(res.status).toBe(400);
  });
});
