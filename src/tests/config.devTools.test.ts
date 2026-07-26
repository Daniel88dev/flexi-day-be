/**
 * The environment gates that decide whether the local `/api/dev/*` surface can
 * exist at all. Test library/framework: Vitest
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TOKEN = "local-dev-token-0123456789";

const ORIGINAL_ENV = { ...process.env };

/** Config is evaluated once at import, so each case needs a fresh module graph. */
const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (mod as { config: { dev?: { token: string; seedEmailDomain: string } } }).config;
};

// Every dev var is pinned: config.ts calls dotenv, which would otherwise fill
// unset ones in from the developer's own `.env` and change what is under test.
const BASE = {
  PORT: "8080",
  DATABASE: "postgres://localhost:5432/flexi-day",
  BETTER_AUTH_SECRET: "secret",
  BETTER_AUTH_URL: "http://localhost:8080",
  DEV_TOOLS_ENABLED: "false",
  DEV_TOOLS_TOKEN: "",
  DEV_SEED_EMAIL_DOMAIN: "dev.local",
};

describe("config dev tools gate", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is off unless explicitly enabled", async () => {
    const config = await loadConfig({ ...BASE, NODE_ENV: "dev" });
    expect(config.dev).toBeUndefined();
  });

  it("is off when the flag is anything other than the literal true", async () => {
    const config = await loadConfig({ ...BASE, NODE_ENV: "dev", DEV_TOOLS_ENABLED: "1" });
    expect(config.dev).toBeUndefined();
  });

  it("refuses to start in production even when enabled", async () => {
    await expect(
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        DEV_TOOLS_ENABLED: "true",
        DEV_TOOLS_TOKEN: TOKEN,
      })
    ).rejects.toThrow(/never be set when NODE_ENV=production/);
  });

  it("refuses a non-local database", async () => {
    await expect(
      loadConfig({
        ...BASE,
        NODE_ENV: "dev",
        DATABASE: "postgres://db.example.com:5432/flexi-day",
        DEV_TOOLS_ENABLED: "true",
        DEV_TOOLS_TOKEN: TOKEN,
      })
    ).rejects.toThrow(/is not local/);
  });

  it("refuses a missing or too-short token", async () => {
    await expect(
      loadConfig({ ...BASE, NODE_ENV: "dev", DEV_TOOLS_ENABLED: "true" })
    ).rejects.toThrow(/DEV_TOOLS_TOKEN/);

    await expect(
      loadConfig({
        ...BASE,
        NODE_ENV: "dev",
        DEV_TOOLS_ENABLED: "true",
        DEV_TOOLS_TOKEN: "short",
      })
    ).rejects.toThrow(/at least 16 characters/);
  });

  it("enables on a local database with a valid token", async () => {
    const config = await loadConfig({
      ...BASE,
      NODE_ENV: "dev",
      DEV_TOOLS_ENABLED: "true",
      DEV_TOOLS_TOKEN: TOKEN,
    });
    expect(config.dev).toEqual({ token: TOKEN, seedEmailDomain: "dev.local" });
  });
});
