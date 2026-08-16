import dotenv from "dotenv";
dotenv.config();

type APIConfig = { port: number; env: "production" | "dev" | "test" };

type DBConfig = { database: string };

type AuthConfig = {
  secret: string;
  url: string;
  trustedOrigins: string[];
  // Google OAuth. Optional: absent in test and until the credentials are
  // provisioned. The client secret is sensitive; the client id is not.
  googleClientId?: string;
  googleClientSecret?: string;
};

type EmailConfig = {
  from: string;
  templateStage: "dev" | "prod";
  region: string;
  configurationSet?: string;
  // Frontend app base URL. better-auth redirects the browser here
  // (`/email-verified/`) after verifying an email token, so it MUST be within
  // `auth.trustedOrigins` or better-auth rejects the redirect.
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

type DevToolsConfig = {
  /** Shared secret every `/api/dev/*` request must present as `x-dev-token`. */
  token: string;
  /** The only email domain the dev routes may create — and the only one reset may delete. */
  seedEmailDomain: string;
};

type Config = {
  api: APIConfig;
  db: DBConfig;
  auth?: AuthConfig;
  email: EmailConfig;
  quotaRollover: QuotaRolloverConfig;
  /** Billing via Paddle. `undefined` until the keys are provisioned — billing routes then 503. */
  paddle?: PaddleConfig;
  /** Local seeding/session surface. `undefined` means the routes do not exist. */
  dev?: DevToolsConfig;
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

const parseTemplateStage = (): "dev" | "prod" => {
  const raw = process.env.EMAIL_TEMPLATE_STAGE?.toLowerCase();
  if (raw === "dev" || raw === "prod") return raw;
  if (raw !== undefined) {
    throw new Error(`Invalid EMAIL_TEMPLATE_STAGE: "${raw}". Expected "dev" or "prod"`);
  }
  return environment === "production" ? "prod" : "dev";
};

const databaseUrl = envOrThrow("DATABASE");

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
  auth:
    environment !== "test"
      ? {
          secret: envOrThrow("BETTER_AUTH_SECRET"),
          url: envOrThrow("BETTER_AUTH_URL"),
          trustedOrigins: process.env.TRUSTED_ORIGINS?.split(",") ?? ["http://localhost:3000"],
          googleClientId: process.env.GOOGLE_CLIENT_ID,
          googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
        }
      : undefined,
  email: {
    from: process.env.EMAIL_FROM ?? "no-reply@flexi-day.com",
    templateStage: parseTemplateStage(),
    region: process.env.AWS_REGION ?? "eu-central-1",
    configurationSet: process.env.SES_CONFIGURATION_SET,
    appUrl:
      process.env.APP_URL ??
      (environment === "production" ? "https://www.flexi-day.com" : "http://localhost:3000"),
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
};

export type { PaddleConfig };
