/**
 * The env gate for the platform-support surface allowlist.
 * Test library/framework: Vitest
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/** Config is evaluated once at import, so each case needs a fresh module graph. */
const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (mod as { config: { support?: { userIds: string[] } } }).config;
};

// Pinned so the developer's own `.env` (read by dotenv inside config.ts)
// cannot change what is under test.
const BASE = {
  NODE_ENV: "dev",
  PORT: "8080",
  DATABASE: "postgres://localhost:5432/flexi-day",
  BETTER_AUTH_SECRET: "secret",
  BETTER_AUTH_URL: "http://localhost:8080",
  DEV_TOOLS_ENABLED: "false",
  SUPPORT_ADMIN_USER_IDS: "",
};

const ID_A = "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b";
const ID_B = "k2mfp8w1qrtz5xcvbn3hjl7dysagu4e6";

describe("config support allowlist", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is off when the variable is unset or empty", async () => {
    expect((await loadConfig({ ...BASE })).support).toBeUndefined();
    expect((await loadConfig({ ...BASE, SUPPORT_ADMIN_USER_IDS: " , ," })).support).toBeUndefined();
  });

  it("splits, trims and de-duplicates the list", async () => {
    const config = await loadConfig({
      ...BASE,
      SUPPORT_ADMIN_USER_IDS: ` ${ID_A} ,${ID_B},${ID_A}`,
    });
    expect(config.support?.userIds).toEqual([ID_A, ID_B]);
  });

  it("throws at boot on an entry that is not a user id", async () => {
    await expect(
      loadConfig({ ...BASE, SUPPORT_ADMIN_USER_IDS: "owner@dev.local" })
    ).rejects.toThrow(/does not look like a user id/);
  });
});
