import { describe, it, expect, afterEach, vi } from "vitest";
import type { ApnsConfig } from "../config.js";

const ORIGINAL_ENV = { ...process.env };

const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (mod as { config: { apns?: ApnsConfig } }).config;
};

// Every variable is pinned: dotenv inside config.ts would otherwise fill unset ones from `.env`.
const BASE = {
  NODE_ENV: "dev",
  PORT: "8080",
  DATABASE: "postgres://localhost:5432/flexi-day",
  BETTER_AUTH_SECRET: "secret",
  BETTER_AUTH_URL: "http://localhost:8080",
  DEV_TOOLS_ENABLED: "false",
  SUPPORT_ADMIN_USER_IDS: "",
  PADDLE_API_KEY: "",
  APNS_KEY_ID: "",
  APNS_TEAM_ID: "",
  APNS_TOPIC: "",
  APNS_PRIVATE_KEY: "",
};

const APNS = {
  APNS_KEY_ID: "KEY1234567",
  APNS_TEAM_ID: "TEAM123456",
  APNS_TOPIC: "com.flexiday.app",
  APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
};

describe("config APNs", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is absent when none of the four is set", async () => {
    const config = await loadConfig(BASE);
    expect(config.apns).toBeUndefined();
  });

  it("carries all four when all are set", async () => {
    const config = await loadConfig({ ...BASE, ...APNS });
    expect(config.apns).toEqual({
      keyId: "KEY1234567",
      teamId: "TEAM123456",
      topic: "com.flexiday.app",
      privateKey: APNS.APNS_PRIVATE_KEY,
    });
  });

  it.each(Object.keys(APNS))("refuses to boot when only %s is missing", async (missing) => {
    await expect(loadConfig({ ...BASE, ...APNS, [missing]: "" })).rejects.toThrow(missing);
  });

  it("refuses to boot when only one of the four is set", async () => {
    await expect(loadConfig({ ...BASE, APNS_KEY_ID: "KEY1234567" })).rejects.toThrow(
      /APNS_TEAM_ID, APNS_TOPIC, APNS_PRIVATE_KEY/
    );
  });
});
