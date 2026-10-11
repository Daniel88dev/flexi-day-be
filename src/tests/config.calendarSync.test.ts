import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CalendarSyncConfig } from "../config.js";

const ORIGINAL_ENV = { ...process.env };

const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (mod as { config: { calendarSync?: CalendarSyncConfig } }).config;
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
  APP_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  MICROSOFT_CLIENT_ID: "",
  MICROSOFT_CLIENT_SECRET: "",
  CALENDAR_SYNC_GOOGLE_ENABLED: "",
  CALENDAR_SYNC_MICROSOFT_ENABLED: "",
  CALENDAR_SYNC_DRIVER: "",
};

const GOOGLE_CREDENTIALS = { GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "google-secret" };
const MICROSOFT_CREDENTIALS = {
  MICROSOFT_CLIENT_ID: "microsoft-id",
  MICROSOFT_CLIENT_SECRET: "microsoft-secret",
};

const PRODUCTION = {
  NODE_ENV: "production",
  ATTACHMENTS_BUCKET: "bucket",
  ATTACHMENTS_CALLBACK_SECRET: "callback-secret",
};

describe("config calendar direct sync", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is absent when both switches are off", async () => {
    const config = await loadConfig({ ...BASE, ...GOOGLE_CREDENTIALS, ...MICROSOFT_CREDENTIALS });
    expect(config.calendarSync).toBeUndefined();
  });

  it("is absent when a switch is anything other than the literal true", async () => {
    const config = await loadConfig({
      ...BASE,
      ...GOOGLE_CREDENTIALS,
      CALENDAR_SYNC_GOOGLE_ENABLED: "1",
    });
    expect(config.calendarSync).toBeUndefined();
  });

  it("ignores a switch whose provider has no sign-in credentials", async () => {
    const config = await loadConfig({
      ...BASE,
      GOOGLE_CLIENT_ID: "google-id",
      CALENDAR_SYNC_GOOGLE_ENABLED: "true",
      CALENDAR_SYNC_MICROSOFT_ENABLED: "true",
    });
    expect(config.calendarSync).toBeUndefined();
  });

  it("turns on only the providers whose switch and credentials are both set", async () => {
    const config = await loadConfig({
      ...BASE,
      ...GOOGLE_CREDENTIALS,
      CALENDAR_SYNC_GOOGLE_ENABLED: "true",
      CALENDAR_SYNC_MICROSOFT_ENABLED: "true",
    });
    expect(config.calendarSync).toEqual({
      googleEnabled: true,
      microsoftEnabled: false,
      driver: "live",
      appUrl: "http://localhost:3000",
      apiUrl: "http://localhost:8080",
      google: { clientId: "google-id", clientSecret: "google-secret" },
      microsoft: undefined,
    });
  });

  it("turns Microsoft on by itself", async () => {
    const config = await loadConfig({
      ...BASE,
      ...MICROSOFT_CREDENTIALS,
      CALENDAR_SYNC_MICROSOFT_ENABLED: "true",
    });
    expect(config.calendarSync).toMatchObject({
      googleEnabled: false,
      microsoftEnabled: true,
      microsoft: { clientId: "microsoft-id", clientSecret: "microsoft-secret" },
    });
    expect(config.calendarSync?.google).toBeUndefined();
  });

  it("accepts the fake driver outside production", async () => {
    const config = await loadConfig({
      ...BASE,
      ...GOOGLE_CREDENTIALS,
      CALENDAR_SYNC_GOOGLE_ENABLED: "true",
      CALENDAR_SYNC_DRIVER: "fake",
    });
    expect(config.calendarSync?.driver).toBe("fake");
  });

  it("rejects an unknown driver", async () => {
    await expect(loadConfig({ ...BASE, CALENDAR_SYNC_DRIVER: "google" })).rejects.toThrow(
      /Invalid CALENDAR_SYNC_DRIVER/
    );
  });

  it("refuses to boot on the fake driver in production, even with both switches off", async () => {
    await expect(
      loadConfig({ ...BASE, ...PRODUCTION, CALENDAR_SYNC_DRIVER: "fake" })
    ).rejects.toThrow("CALENDAR_SYNC_DRIVER=fake must never be set when NODE_ENV=production");
  });

  it("boots in production on the live driver", async () => {
    const config = await loadConfig({
      ...BASE,
      ...PRODUCTION,
      ...GOOGLE_CREDENTIALS,
      CALENDAR_SYNC_GOOGLE_ENABLED: "true",
      APP_URL: "https://www.flexi-day.com",
      BETTER_AUTH_URL: "https://api.flexi-day.com/",
    });
    expect(config.calendarSync).toEqual({
      googleEnabled: true,
      microsoftEnabled: false,
      driver: "live",
      appUrl: "https://www.flexi-day.com",
      apiUrl: "https://api.flexi-day.com",
      google: { clientId: "google-id", clientSecret: "google-secret" },
      microsoft: undefined,
    });
  });
});
