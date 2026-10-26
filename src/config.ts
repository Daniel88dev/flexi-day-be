import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import path from "node:path";
dotenv.config();

type APIConfig = { port: number; env: "production" | "dev" | "test" };

type DBConfig = { database: string };

type AuthConfig = {
  /** The current secret version's value. */
  secret: string;
  url: string;
  // Google OAuth. Optional: absent in test and until the credentials are
  // provisioned. The client secret is sensitive; the client id is not.
  googleClientId?: string;
  googleClientSecret?: string;
  // Microsoft Entra ID OAuth. Same opt-in shape as Google. `tenantId` selects
  // which directory may sign in — "common" (the better-auth default) accepts
  // any work/school account plus personal Microsoft accounts; a GUID restricts
  // sign-in to that single tenant.
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
  // Sign in with Apple. Registered only when all five are set. The client id
  // is the Services ID; the private key is the `.p8` the backend mints its
  // client secrets from, and the only sensitive value of the five.
  appleClientId?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  appleAppBundleIdentifier?: string;
  applePrivateKey?: string;
};

type AuthSecretsConfig = {
  /** Newest first. better-auth encrypts and signs with the first and decrypts with any of them. */
  secrets: { version: number; value: string }[];
  /** Decrypts ciphertext from before versioning, which names no version. Version 1 is that key. */
  legacySecret?: string;
};

type EmailConfig = {
  from: string;
  templateStage: "dev" | "prod";
  region: string;
  configurationSet?: string;
  // Frontend app base URL. better-auth redirects the browser here
  // (`/email-verified/`) after verifying an email token, so it MUST be within
  // `trustedOrigins` or better-auth rejects the redirect.
  appUrl: string;
};

type QuotaRolloverConfig = {
  enabled: boolean;
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA zone the expression is evaluated in. */
  timezone: string;
};

type PaddleConfig = {
  apiKey: string;
  webhookSecret: string;
  environment: "sandbox" | "production";
  /** Paddle price ids for the six catalog prices (EUR, tax-exclusive). */
  prices: {
    proMonthly: string;
    proYearly: string;
    enterpriseMonthly: string;
    enterpriseYearly: string;
    extraGroupMonthly: string;
    extraGroupYearly: string;
  };
};

type SupportConfig = {
  /** User ids allowed on `/api/support/*` and flagged `supportAdmin` in the session. */
  userIds: string[];
};

type AttachmentsConfig = {
  /** S3 bucket for attachment bytes. Unset means the disk store serves them from `localDir`. */
  bucket?: string;
  region: string;
  localDir: string;
  /**
   * HMAC key the `attachment-processor` Lambda signs its callback with. Unset
   * means the callback route does not exist; required alongside the bucket.
   */
  callbackSecret?: string;
};

type OrganizationDataConfig = {
  /**
   * The organization-data bucket (`exports/` today). Unset means the disk store
   * under `localDir`, except in production, where nothing is stored until it is set.
   */
  bucket?: string;
  /** Read for field encryption later; the bucket's default SSE-KMS key covers the store. */
  kmsKeyArn?: string;
  region: string;
  localDir: string;
};

type OAuthClientCredentials = { clientId: string; clientSecret: string };

type CalendarSyncConfig = {
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  driver: "live" | "fake";
  appUrl: string;
  /** Base of the callback URIs registered at the portals: `{apiUrl}/api/calendar-sync/connections/{provider}/callback`. */
  apiUrl: string;
  /** The sign-in client, present only while its switch is on. */
  google?: OAuthClientCredentials;
  microsoft?: OAuthClientCredentials;
};

type DevToolsConfig = {
  /** Shared secret every `/api/dev/*` request must present as `x-dev-token`. */
  token: string;
  /** The only email domain the dev routes may create — and the only one reset may delete. */
  seedEmailDomain: string;
};

type ApnsConfig = {
  keyId: string;
  teamId: string;
  /** The app's bundle id, sent as `apns-topic`. */
  topic: string;
  privateKey: string;
};

type Config = {
  api: APIConfig;
  db: DBConfig;
  /**
   * Origins better-auth accepts, web ones plus the phone app's `flexiday://`.
   * Outside `auth` because that block is absent under test and the e2e suite
   * drives the origin check.
   */
  trustedOrigins: string[];
  auth?: AuthConfig;
  /** `undefined` only under test with neither variable set, where better-auth uses its own. */
  authSecrets?: AuthSecretsConfig;
  email: EmailConfig;
  quotaRollover: QuotaRolloverConfig;
  /** Billing via Paddle. `undefined` until the keys are provisioned — billing routes then 503. */
  paddle?: PaddleConfig;
  /** Local seeding/session surface. `undefined` means the routes do not exist. */
  dev?: DevToolsConfig;
  /** Platform-support read surface. `undefined` means the routes do not exist. */
  support?: SupportConfig;
  attachments: AttachmentsConfig;
  organizationData: OrganizationDataConfig;
  /** Direct writes into users' Google or Microsoft calendars. `undefined` when no provider is on. */
  calendarSync?: CalendarSyncConfig;
  /** Push to phones straight through APNs. `undefined` means the log sender stands in. */
  apns?: ApnsConfig;
};

const VALID_ENVS = ["production", "dev", "test"] as const;
type NodeEnv = (typeof VALID_ENVS)[number];

function envOrThrow(key: string) {
  // eslint-disable-next-line security/detect-object-injection
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

const parseNodeEnv = (value: string): NodeEnv => {
  const v = value.toLowerCase();
  if (v === "prod") return "production"; // backward-compat
  if ((VALID_ENVS as readonly string[]).includes(v)) return v as NodeEnv;
  throw new Error(`Invalid NODE_ENV: "${value}". Expected one of ${VALID_ENVS.join(", ")}`);
};

const environment = parseNodeEnv(envOrThrow("NODE_ENV"));

const SECRET_ENTRY = /^([1-9]\d*):(.+)$/;

// `BETTER_AUTH_SECRETS` is `<version>:<secret>` pairs, newest first. A lone
// `BETTER_AUTH_SECRET` is version 1, which is what it was before versioning.
// Terraform also sets `BETTER_AUTH_SECRET_VERSION` to the newest version, so a
// deployment that resolved a stale list fails here instead of running on it.
const parseAuthSecrets = (): AuthSecretsConfig | undefined => {
  const raw = process.env.BETTER_AUTH_SECRETS?.trim();
  if (!raw) {
    const single = process.env.BETTER_AUTH_SECRET;
    if (single) return { secrets: [{ version: 1, value: single }], legacySecret: single };
    if (environment === "test") return undefined;
    throw new Error("Missing environment variable: BETTER_AUTH_SECRETS or BETTER_AUTH_SECRET");
  }

  const secrets = raw.split(",").map((entry, index) => {
    const [, version, value] = SECRET_ENTRY.exec(entry.trim()) ?? [];
    if (!version || !value) {
      throw new Error(
        `Invalid BETTER_AUTH_SECRETS entry ${index + 1}: expected "<version>:<secret>"`
      );
    }
    return { version: Number(version), value };
  });
  secrets.reduce((newer, older) => {
    if (older.version >= newer.version) {
      throw new Error("BETTER_AUTH_SECRETS must list each version once, newest first");
    }
    return older;
  });
  const expected = process.env.BETTER_AUTH_SECRET_VERSION;
  if (expected && Number(expected) !== secrets[0]?.version) {
    throw new Error(
      `BETTER_AUTH_SECRET_VERSION is ${expected} but the newest version in BETTER_AUTH_SECRETS is ${secrets[0]?.version}`
    );
  }
  return { secrets, legacySecret: secrets.find((s) => s.version === 1)?.value };
};

const parseTemplateStage = (): "dev" | "prod" => {
  const raw = process.env.EMAIL_TEMPLATE_STAGE?.toLowerCase();
  if (raw === "dev" || raw === "prod") return raw;
  if (raw !== undefined) {
    throw new Error(`Invalid EMAIL_TEMPLATE_STAGE: "${raw}". Expected "dev" or "prod"`);
  }
  return environment === "production" ? "prod" : "dev";
};

const databaseUrl = envOrThrow("DATABASE");

const awsRegion = process.env.AWS_REGION ?? "eu-central-1";

const appUrl =
  process.env.APP_URL ??
  (environment === "production" ? "https://www.flexi-day.com" : "http://localhost:3000");

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Paddle stays optional so every environment without keys (tests, fresh local
 * setups) boots normally — but once PADDLE_API_KEY is present, every other
 * variable must be too, so a half-configured deploy fails at boot instead of
 * at the first checkout.
 */
const parsePaddle = (): PaddleConfig | undefined => {
  if (!process.env.PADDLE_API_KEY) return undefined;

  const rawEnv =
    process.env.PADDLE_ENV ?? (environment === "production" ? "production" : "sandbox");
  if (rawEnv !== "sandbox" && rawEnv !== "production") {
    throw new Error(`Invalid PADDLE_ENV: "${rawEnv}". Expected "sandbox" or "production"`);
  }
  if (environment === "production" && rawEnv === "sandbox") {
    throw new Error("PADDLE_ENV=sandbox must never be set when NODE_ENV=production");
  }

  const prices = {
    proMonthly: envOrThrow("PADDLE_PRICE_PRO_MONTHLY"),
    proYearly: envOrThrow("PADDLE_PRICE_PRO_YEARLY"),
    enterpriseMonthly: envOrThrow("PADDLE_PRICE_ENTERPRISE_MONTHLY"),
    enterpriseYearly: envOrThrow("PADDLE_PRICE_ENTERPRISE_YEARLY"),
    extraGroupMonthly: envOrThrow("PADDLE_PRICE_EXTRA_GROUP_MONTHLY"),
    extraGroupYearly: envOrThrow("PADDLE_PRICE_EXTRA_GROUP_YEARLY"),
  };

  // A price id pasted into two slots would make `derivePlanFromItems` resolve
  // the wrong plan from a webhook — cheap to catch at boot, invisible later.
  if (new Set(Object.values(prices)).size !== Object.keys(prices).length) {
    throw new Error("Paddle price ids must all be distinct");
  }

  return {
    apiKey: envOrThrow("PADDLE_API_KEY"),
    webhookSecret: envOrThrow("PADDLE_WEBHOOK_SECRET"),
    environment: rawEnv,
    prices,
  };
};

/**
 * Gate for the local dev/seeding surface (`/api/dev/*`). It stays `undefined`
 * unless explicitly switched on, and it refuses to exist anywhere it could
 * reach real data. Throwing rather than quietly returning `undefined` is
 * deliberate: a deploy that somehow carries the flag must fail at boot instead
 * of silently serving seeding endpoints.
 */
const parseDevTools = (): DevToolsConfig | undefined => {
  if (process.env.DEV_TOOLS_ENABLED !== "true") return undefined;

  if (environment === "production") {
    throw new Error("DEV_TOOLS_ENABLED must never be set when NODE_ENV=production");
  }

  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DEV_TOOLS_ENABLED is set but DATABASE is not a parseable URL");
  }
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `DEV_TOOLS_ENABLED is set but DATABASE host "${host}" is not local — refusing to start`
    );
  }

  const token = envOrThrow("DEV_TOOLS_TOKEN");
  if (token.length < 16) {
    throw new Error("DEV_TOOLS_TOKEN must be at least 16 characters");
  }

  return {
    token,
    seedEmailDomain: process.env.DEV_SEED_EMAIL_DOMAIN ?? "dev.local",
  };
};

/**
 * Allowlist for the read-only support surface (`/api/support/*`). An env var
 * rather than a DB flag on purpose: no API can ever grant it, so there is no
 * privilege-escalation surface — it changes only via deploy. Unset means the
 * router is never mounted and the surface does not exist.
 */
const parseSupport = (): SupportConfig | undefined => {
  const raw = process.env.SUPPORT_ADMIN_USER_IDS;
  if (!raw) return undefined;

  const userIds = [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];
  if (userIds.length === 0) return undefined;

  // better-auth ids are 32-char alphanumeric and dev-seeded ones are dashed
  // UUIDs; anything else is a typo or a pasted email. Failing at boot beats an
  // allowlist that silently never matches.
  for (const id of userIds) {
    const isBetterAuthId = /^[A-Za-z0-9]{32}$/.test(id);
    const isUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
    if (!isBetterAuthId && !isUuid) {
      throw new Error(
        `SUPPORT_ADMIN_USER_IDS contains "${id}", which does not look like a user id`
      );
    }
  }

  return { userIds };
};

const parseTrustedOrigins = (): string[] => {
  const origins = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : ["http://localhost:3000"];
};

/**
 * The disk store is a development stand-in: per-instance, ephemeral, and it
 * mounts session-less upload and download routes. Production must name a
 * bucket, so a deploy without one fails at boot rather than losing files.
 */
const parseAttachments = (): AttachmentsConfig => {
  const bucket = process.env.ATTACHMENTS_BUCKET || undefined;
  if (environment === "production" && !bucket) {
    throw new Error("ATTACHMENTS_BUCKET is required when NODE_ENV=production");
  }
  // The e2e suite drives the callback route itself and reads the key from
  // here, so under test a per-process key stands in for a configured one.
  const callbackSecret =
    process.env.ATTACHMENTS_CALLBACK_SECRET ||
    (environment === "test" ? randomBytes(32).toString("hex") : undefined);
  if (bucket && !callbackSecret) {
    throw new Error("ATTACHMENTS_CALLBACK_SECRET is required when ATTACHMENTS_BUCKET is set");
  }
  return {
    bucket,
    region: awsRegion,
    // Under the checkout, not the OS temp dir: that one is shared with every
    // other user of the machine.
    localDir: process.env.ATTACHMENTS_DIR || path.resolve(".attachments", environment),
    callbackSecret,
  };
};

// Optional even in production: the Terraform that creates the bucket is applied
// by hand, and a required variable would stop the deploy before it is.
const parseOrganizationData = (): OrganizationDataConfig => ({
  bucket: process.env.ORGANIZATION_DATA_BUCKET || undefined,
  kmsKeyArn: process.env.ORGANIZATION_DATA_KMS_KEY_ARN || undefined,
  region: awsRegion,
  localDir: process.env.ORGANIZATION_DATA_DIR || path.resolve(".organization-data", environment),
});

/**
 * Connections reuse the sign-in OAuth clients, so a provider's switch counts
 * only while that provider's sign-in credentials are configured.
 */
const parseCalendarSync = (): CalendarSyncConfig | undefined => {
  const rawDriver = process.env.CALENDAR_SYNC_DRIVER || "live";
  if (rawDriver !== "live" && rawDriver !== "fake") {
    throw new Error(`Invalid CALENDAR_SYNC_DRIVER: "${rawDriver}". Expected "live" or "fake"`);
  }
  if (environment === "production" && rawDriver === "fake") {
    throw new Error("CALENDAR_SYNC_DRIVER=fake must never be set when NODE_ENV=production");
  }

  const client = (
    enabled: string | undefined,
    clientId: string | undefined,
    clientSecret: string | undefined
  ): OAuthClientCredentials | undefined =>
    enabled === "true" && clientId && clientSecret ? { clientId, clientSecret } : undefined;

  const google = client(
    process.env.CALENDAR_SYNC_GOOGLE_ENABLED,
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  const microsoft = client(
    process.env.CALENDAR_SYNC_MICROSOFT_ENABLED,
    process.env.MICROSOFT_CLIENT_ID,
    process.env.MICROSOFT_CLIENT_SECRET
  );
  if (!google && !microsoft) return undefined;

  return {
    googleEnabled: Boolean(google),
    microsoftEnabled: Boolean(microsoft),
    driver: rawDriver,
    appUrl,
    apiUrl: (process.env.BETTER_AUTH_URL || "http://localhost:8080").replace(/\/+$/, ""),
    google,
    microsoft,
  };
};

const parseApns = (): ApnsConfig | undefined => {
  const {
    APNS_KEY_ID: keyId,
    APNS_TEAM_ID: teamId,
    APNS_TOPIC: topic,
    APNS_PRIVATE_KEY: privateKey,
  } = process.env;
  if (!keyId && !teamId && !topic && !privateKey) return undefined;
  if (!keyId || !teamId || !topic || !privateKey) {
    const missing = Object.entries({
      APNS_KEY_ID: keyId,
      APNS_TEAM_ID: teamId,
      APNS_TOPIC: topic,
      APNS_PRIVATE_KEY: privateKey,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new Error(`APNs config is all or none, and these are missing: ${missing.join(", ")}`);
  }
  return { keyId, teamId, topic, privateKey };
};

const authSecrets = parseAuthSecrets();

export const config: Config = {
  api: {
    port: (() => {
      const raw = envOrThrow("PORT");
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid PORT: "${raw}"`);
      return n;
    })(),
    env: environment,
  },
  db: {
    database: databaseUrl,
  },
  trustedOrigins: parseTrustedOrigins(),
  authSecrets,
  auth:
    environment !== "test"
      ? {
          secret: authSecrets?.secrets[0]?.value ?? envOrThrow("BETTER_AUTH_SECRETS"),
          url: envOrThrow("BETTER_AUTH_URL"),
          googleClientId: process.env.GOOGLE_CLIENT_ID,
          googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
          microsoftClientId: process.env.MICROSOFT_CLIENT_ID,
          microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET,
          microsoftTenantId: process.env.MICROSOFT_TENANT_ID,
          appleClientId: process.env.APPLE_CLIENT_ID,
          appleTeamId: process.env.APPLE_TEAM_ID,
          appleKeyId: process.env.APPLE_KEY_ID,
          appleAppBundleIdentifier: process.env.APPLE_APP_BUNDLE_IDENTIFIER,
          applePrivateKey: process.env.APPLE_PRIVATE_KEY,
        }
      : undefined,
  email: {
    from: process.env.EMAIL_FROM ?? "no-reply@flexi-day.com",
    templateStage: parseTemplateStage(),
    region: awsRegion,
    configurationSet: process.env.SES_CONFIGURATION_SET,
    appUrl,
  },
  quotaRollover: {
    // Off under test so the e2e suite drives the rollover explicitly instead
    // of racing a timer.
    enabled: process.env.QUOTA_ROLLOVER_ENABLED
      ? process.env.QUOTA_ROLLOVER_ENABLED === "true"
      : environment !== "test",
    // Daily rather than once on 1 January: the job is a no-op when every
    // member already has a row, and a yearly trigger would be missed outright
    // if the service happened to be down on the day.
    cron: process.env.QUOTA_ROLLOVER_CRON ?? "0 2 * * *",
    timezone: process.env.QUOTA_ROLLOVER_TIMEZONE ?? "Europe/Prague",
  },
  paddle: parsePaddle(),
  dev: parseDevTools(),
  support: parseSupport(),
  attachments: parseAttachments(),
  organizationData: parseOrganizationData(),
  calendarSync: parseCalendarSync(),
  apns: parseApns(),
};

export type { ApnsConfig, CalendarSyncConfig, PaddleConfig };
