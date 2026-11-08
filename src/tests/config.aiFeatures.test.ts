import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  AiFeaturesConfig,
  AssistantConfig,
  KnowledgeBaseConfig,
  PrivacyBannerConfig,
} from "../config.js";

const ORIGINAL_ENV = { ...process.env };

const loadConfig = async (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("../config.js");
  return (
    mod as {
      config: {
        aiFeatures: AiFeaturesConfig;
        assistant: AssistantConfig;
        knowledgeBase: KnowledgeBaseConfig;
        privacyBanner: PrivacyBannerConfig;
      };
    }
  ).config;
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
  ASSISTANT_MODEL: "",
  ASSISTANT_EFFORT: "",
  ANTHROPIC_API_KEY: "",
  ASSISTANT_AGENT_ID: "",
  ASSISTANT_ENVIRONMENT_ID: "",
  ANTHROPIC_WEBHOOK_SECRET: "",
  ASSISTANT_CHAT_TOKEN_CEILING: "",
  ASSISTANT_SCREEN_MODEL: "",
  ASSISTANT_WEEKLY_LIMIT_USD: "",
  ASSISTANT_STEP_OUTPUT_RESERVE: "",
  KB_BUNDLE_URL: "",
  PRIVACY_BANNER_FROM: "",
};

const PRODUCTION = {
  NODE_ENV: "production",
  ATTACHMENTS_BUCKET: "bucket",
  ATTACHMENTS_CALLBACK_SECRET: "callback-secret",
};

const PRODUCTION_ASSISTANT = {
  ANTHROPIC_API_KEY: "sk-ant-test-not-a-key",
  ANTHROPIC_WEBHOOK_SECRET: "whsec_dGVzdC1ub3QtYS1zZWNyZXQ=",
  ASSISTANT_AGENT_ID: "agent_01Test",
  ASSISTANT_ENVIRONMENT_ID: "env_01Test",
  KB_BUNDLE_URL: "https://www.flexi-day.com/help/kb.json",
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
    expect(config.assistant).toEqual({
      driver: "fake",
      model: "claude-sonnet-5-5",
      effort: "medium",
      screenModel: "claude-haiku-5-5",
      screenTimeoutMs: 5000,
      chatTokenCeiling: 100_000,
      stepOutputReserve: 4096,
      weeklyLimitMicroUsd: 10_000_000,
    });
    expect(config.assistant.apiKey).toBeUndefined();
    expect(config.assistant.webhookSecret).toBeUndefined();
  });

  it("reads the managed driver's model, ids and limits", async () => {
    const config = await loadConfig({
      ...BASE,
      ASSISTANT_MODEL: "claude-haiku-5-5",
      ASSISTANT_EFFORT: "low",
      ASSISTANT_AGENT_ID: "agent_01Test",
      ASSISTANT_ENVIRONMENT_ID: "env_01Test",
      ASSISTANT_CHAT_TOKEN_CEILING: "50000",
      ASSISTANT_STEP_OUTPUT_RESERVE: "2048",
      ASSISTANT_SCREEN_MODEL: "claude-sonnet-5-5",
      ASSISTANT_SCREEN_TIMEOUT_MS: "3000",
    });
    expect(config.assistant).toMatchObject({
      screenModel: "claude-sonnet-5-5",
      screenTimeoutMs: 3000,
      model: "claude-haiku-5-5",
      effort: "low",
      agentId: "agent_01Test",
      environmentId: "env_01Test",
      chatTokenCeiling: 50_000,
      stepOutputReserve: 2048,
    });
  });

  it("keeps the key and the webhook secret out of anything that prints the config", async () => {
    const config = await loadConfig({
      ...BASE,
      ANTHROPIC_API_KEY: "sk-ant-test-not-a-key",
      ANTHROPIC_WEBHOOK_SECRET: "whsec_dGVzdC1ub3QtYS1zZWNyZXQ=",
    });
    expect(config.assistant.apiKey).toBe("sk-ant-test-not-a-key");
    expect(config.assistant.webhookSecret).toBe("whsec_dGVzdC1ub3QtYS1zZWNyZXQ=");
    const printed = JSON.stringify({ ...config.assistant, all: config.assistant });
    expect(printed).not.toContain("sk-ant");
    expect(printed).not.toContain("whsec_");
  });

  it("rejects an unknown effort, a webhook secret without its prefix and a bad limit", async () => {
    await expect(loadConfig({ ...BASE, ASSISTANT_EFFORT: "extreme" })).rejects.toThrow(
      'Invalid ASSISTANT_EFFORT: "extreme"'
    );
    await expect(loadConfig({ ...BASE, ANTHROPIC_WEBHOOK_SECRET: "secret" })).rejects.toThrow(
      "ANTHROPIC_WEBHOOK_SECRET must start with whsec_"
    );
    await expect(loadConfig({ ...BASE, ASSISTANT_CHAT_TOKEN_CEILING: "-1" })).rejects.toThrow(
      'Invalid ASSISTANT_CHAT_TOKEN_CEILING: "-1"'
    );
    await expect(loadConfig({ ...BASE, ASSISTANT_SCREEN_TIMEOUT_MS: "soon" })).rejects.toThrow(
      'Invalid ASSISTANT_SCREEN_TIMEOUT_MS: "soon"'
    );
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

describe("config Assistant meter", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to Sonnet 5.5, the Haiku 5.5 screen, a $10 Weekly limit and a 4,096-token reserve", async () => {
    const config = await loadConfig(BASE);
    expect(config.assistant).toMatchObject({
      model: "claude-sonnet-5-5",
      screenModel: "claude-haiku-5-5",
      weeklyLimitMicroUsd: 10_000_000,
      stepOutputReserve: 4096,
    });
  });

  it("reads the Weekly limit in dollars, cents included", async () => {
    const config = await loadConfig({ ...BASE, ASSISTANT_WEEKLY_LIMIT_USD: "12.50" });
    expect(config.assistant.weeklyLimitMicroUsd).toBe(12_500_000);
  });

  it("rejects a Weekly limit that is not a positive amount", async () => {
    await expect(loadConfig({ ...BASE, ASSISTANT_WEEKLY_LIMIT_USD: "-1" })).rejects.toThrow(
      /ASSISTANT_WEEKLY_LIMIT_USD/
    );
    await expect(loadConfig({ ...BASE, ASSISTANT_WEEKLY_LIMIT_USD: "ten" })).rejects.toThrow(
      /ASSISTANT_WEEKLY_LIMIT_USD/
    );
  });

  it("refuses to boot with a model that has no price row", async () => {
    await expect(loadConfig({ ...BASE, ASSISTANT_MODEL: "claude-opus-5-5" })).rejects.toThrow(
      "ASSISTANT_MODEL claude-opus-5-5 has no row in the price table"
    );
    await expect(
      loadConfig({ ...BASE, ASSISTANT_SCREEN_MODEL: "claude-haiku-4-5" })
    ).rejects.toThrow("ASSISTANT_SCREEN_MODEL claude-haiku-4-5 has no row in the price table");
  });
});

describe("config AI features in production", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("boots dark with no Anthropic secret, id or bundle URL", async () => {
    const config = await loadConfig({ ...BASE, ...PRODUCTION });
    expect(config.assistant.agentId).toBeUndefined();
  });

  it("boots with the Assistant on once its key, secret, ids and bundle URL are set", async () => {
    const config = await loadConfig({
      ...BASE,
      ...PRODUCTION,
      ...PRODUCTION_ASSISTANT,
      ASSISTANT_ENABLED: "true",
    });
    expect(config.assistant).toMatchObject({
      agentId: "agent_01Test",
      environmentId: "env_01Test",
    });
  });

  it("names every missing Assistant value while the switch is on", async () => {
    await expect(loadConfig({ ...BASE, ...PRODUCTION, ASSISTANT_ENABLED: "true" })).rejects.toThrow(
      "ANTHROPIC_API_KEY, ANTHROPIC_WEBHOOK_SECRET, ASSISTANT_AGENT_ID, ASSISTANT_ENVIRONMENT_ID, KB_BUNDLE_URL must be set when NODE_ENV=production and an AI feature is on"
    );
  });

  it("asks for the webhook secret alone when only it is missing", async () => {
    await expect(
      loadConfig({
        ...BASE,
        ...PRODUCTION,
        ...PRODUCTION_ASSISTANT,
        ANTHROPIC_WEBHOOK_SECRET: "",
        ASSISTANT_ENABLED: "true",
      })
    ).rejects.toThrow(/^ANTHROPIC_WEBHOOK_SECRET must be set when NODE_ENV=production/);
  });

  it("treats a preview organization as the Assistant being on", async () => {
    await expect(
      loadConfig({
        ...BASE,
        ...PRODUCTION,
        ...PRODUCTION_ASSISTANT,
        ASSISTANT_AGENT_ID: "",
        AI_PREVIEW_ORGANIZATION_IDS: ORG_A,
      })
    ).rejects.toThrow(/^ASSISTANT_AGENT_ID must be set when NODE_ENV=production/);
  });

  it("needs only the bundle URL while AI connections alone are on", async () => {
    await expect(
      loadConfig({ ...BASE, ...PRODUCTION, AI_CONNECTIONS_ENABLED: "true" })
    ).rejects.toThrow(
      /^KB_BUNDLE_URL must be set when NODE_ENV=production and an AI feature is on/
    );
    const config = await loadConfig({
      ...BASE,
      ...PRODUCTION,
      AI_CONNECTIONS_ENABLED: "true",
      KB_BUNDLE_URL: "https://www.flexi-day.com/help/kb.json",
    });
    expect(config.knowledgeBase.bundleUrl).toBe("https://www.flexi-day.com/help/kb.json");
  });

  it("rejects a bundle URL that is not a URL", async () => {
    await expect(loadConfig({ ...BASE, KB_BUNDLE_URL: "help/kb.json" })).rejects.toThrow(
      'Invalid KB_BUNDLE_URL: "help/kb.json". Expected an absolute http(s) URL'
    );
  });

  it("keeps the local default outside production with every switch on", async () => {
    const config = await loadConfig({
      ...BASE,
      APP_URL: "http://localhost:3000",
      ASSISTANT_ENABLED: "true",
      AI_CONNECTIONS_ENABLED: "true",
    });
    expect(config.knowledgeBase.bundleUrl).toBe("http://localhost:3000/help/kb.json");
  });
});

describe("config Privacy banner", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("has no start date when unset", async () => {
    expect((await loadConfig(BASE)).privacyBanner).toEqual({ from: null });
  });

  it("starts at 00:00 UTC on the given day", async () => {
    const config = await loadConfig({ ...BASE, PRIVACY_BANNER_FROM: "2026-12-01" });
    expect(config.privacyBanner.from?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it.each(["2026-12-1", "2026-02-30", "1 December 2026", "2026-12-01T10:00:00Z"])(
    "rejects %s",
    async (value) => {
      await expect(loadConfig({ ...BASE, PRIVACY_BANNER_FROM: value })).rejects.toThrow(
        `Invalid PRIVACY_BANNER_FROM: "${value}". Expected a date as YYYY-MM-DD`
      );
    }
  );
});
