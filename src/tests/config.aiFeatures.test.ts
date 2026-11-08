import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AiFeaturesConfig, AssistantConfig } from "../config.js";

const ORIGINAL_ENV = { ...process.env };

const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (mod as { config: { aiFeatures: AiFeaturesConfig; assistant: AssistantConfig } }).config;
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
  CALENDAR_SYNC_DRIVER: "",
  ASSISTANT_ENABLED: "",
  AI_CONNECTIONS_ENABLED: "",
  AI_PREVIEW_ORGANIZATION_IDS: "",
  ASSISTANT_DRIVER: "",
};

const PRODUCTION = {
  NODE_ENV: "production",
  ATTACHMENTS_BUCKET: "bucket",
  ATTACHMENTS_CALLBACK_SECRET: "callback-secret",
};

const ORG_A = "6f1c2b0e-8a4d-4c1e-9f3a-2d7b5e8c1a90";
const ORG_B = "0b9e7d3c-1f2a-4e5b-8c6d-7a8b9c0d1e2f";

describe("config AI features", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("ships dark: both switches off, no preview list, the fake driver", async () => {
    const config = await loadConfig(BASE);
    expect(config.aiFeatures).toEqual({
      assistantEnabled: false,
      aiConnectionsEnabled: false,
      previewOrganizationIds: [],
    });
    expect(config.assistant).toEqual({ driver: "fake" });
  });

  it("turns each switch on with the literal true", async () => {
    const config = await loadConfig({
      ...BASE,
      ASSISTANT_ENABLED: "true",
      AI_CONNECTIONS_ENABLED: "false",
    });
    expect(config.aiFeatures.assistantEnabled).toBe(true);
    expect(config.aiFeatures.aiConnectionsEnabled).toBe(false);
  });

  it("rejects a switch that is neither true nor false", async () => {
    await expect(loadConfig({ ...BASE, AI_CONNECTIONS_ENABLED: "yes" })).rejects.toThrow(
      'Invalid AI_CONNECTIONS_ENABLED: "yes". Expected "true" or "false"'
    );
  });

  it("reads the preview list, trimming blanks and repeats", async () => {
    const config = await loadConfig({
      ...BASE,
      AI_PREVIEW_ORGANIZATION_IDS: ` ${ORG_A}, ,${ORG_B},${ORG_A} `,
    });
    expect(config.aiFeatures.previewOrganizationIds).toEqual([ORG_A, ORG_B]);
  });

  it("rejects a preview entry that is not an organization id", async () => {
    await expect(
      loadConfig({ ...BASE, AI_PREVIEW_ORGANIZATION_IDS: `${ORG_A},owner@example.com` })
    ).rejects.toThrow(
      'AI_PREVIEW_ORGANIZATION_IDS contains "owner@example.com", which is not an organization id'
    );
  });

  it("accepts the managed driver outside production", async () => {
    const config = await loadConfig({ ...BASE, ASSISTANT_DRIVER: "managed" });
    expect(config.assistant.driver).toBe("managed");
  });

  it("rejects an unknown driver", async () => {
    await expect(loadConfig({ ...BASE, ASSISTANT_DRIVER: "anthropic" })).rejects.toThrow(
      'Invalid ASSISTANT_DRIVER: "anthropic". Expected "managed" or "fake"'
    );
  });

  it("defaults to the managed driver in production", async () => {
    const config = await loadConfig({ ...BASE, ...PRODUCTION });
    expect(config.assistant.driver).toBe("managed");
  });

  it("refuses to boot on the fake driver in production, even with both switches off", async () => {
    await expect(loadConfig({ ...BASE, ...PRODUCTION, ASSISTANT_DRIVER: "fake" })).rejects.toThrow(
      "ASSISTANT_DRIVER=fake must never be set when NODE_ENV=production"
    );
  });
});
