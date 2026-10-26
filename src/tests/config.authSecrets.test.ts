import { describe, it, expect, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

type Loaded = {
  authSecrets?: { secrets: { version: number; value: string }[]; legacySecret?: string };
  auth?: { secret: string };
};

const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (mod as { config: Loaded }).config;
};

// Every variable is pinned: dotenv inside config.ts would otherwise fill unset ones from `.env`.
const BASE = {
  NODE_ENV: "dev",
  PORT: "8080",
  DATABASE: "postgres://localhost:5432/flexi-day",
  BETTER_AUTH_SECRET: "",
  BETTER_AUTH_SECRETS: "",
  BETTER_AUTH_URL: "http://localhost:8080",
  DEV_TOOLS_ENABLED: "false",
  SUPPORT_ADMIN_USER_IDS: "",
  PADDLE_API_KEY: "",
};

describe("config auth secrets", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("treats a lone BETTER_AUTH_SECRET as version 1 and the pre-versioning key", async () => {
    const config = await loadConfig({ ...BASE, BETTER_AUTH_SECRET: "only" });

    expect(config.authSecrets).toEqual({
      secrets: [{ version: 1, value: "only" }],
      legacySecret: "only",
    });
    expect(config.auth?.secret).toBe("only");
  });

  it("reads versions newest first, signs with the first and keeps version 1 as the legacy key", async () => {
    const config = await loadConfig({ ...BASE, BETTER_AUTH_SECRETS: "2:second, 1:first" });

    expect(config.authSecrets).toEqual({
      secrets: [
        { version: 2, value: "second" },
        { version: 1, value: "first" },
      ],
      legacySecret: "first",
    });
    expect(config.auth?.secret).toBe("second");
  });

  it("has no legacy key once version 1 has rotated out", async () => {
    const config = await loadConfig({
      ...BASE,
      BETTER_AUTH_SECRET: "stale",
      BETTER_AUTH_SECRETS: "3:third,2:second",
    });

    expect(config.authSecrets?.legacySecret).toBeUndefined();
    expect(config.auth?.secret).toBe("third");
  });

  it.each([
    ["an entry without a version", "second"],
    ["version 0", "0:zero"],
    ["an empty secret", "2:"],
    ["versions oldest first", "1:first,2:second"],
    ["a repeated version", "2:a,2:b"],
  ])("refuses to boot on %s", async (_, value) => {
    await expect(loadConfig({ ...BASE, BETTER_AUTH_SECRETS: value })).rejects.toThrow(
      /BETTER_AUTH_SECRETS/
    );
  });

  it("never echoes a secret in its error", async () => {
    await expect(
      loadConfig({ ...BASE, BETTER_AUTH_SECRETS: "x:do-not-print-me" })
    ).rejects.not.toThrow(/do-not-print-me/);
  });

  it("refuses to boot with neither variable outside test", async () => {
    await expect(loadConfig(BASE)).rejects.toThrow(/BETTER_AUTH_SECRETS or BETTER_AUTH_SECRET/);
  });
});
