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

type Config = {
  api: APIConfig;
  db: DBConfig;
  auth?: AuthConfig;
  email: EmailConfig;
};

const VALID_ENVS = ["production", "dev", "test"] as const;
type NodeEnv = (typeof VALID_ENVS)[number];

/**
 * Retrieves an environment variable value or throws if it is not set.
 *
 * @param key - The name of the environment variable to read from `process.env`.
 * @returns The environment variable value as a string.
 * @throws Error if the environment variable is missing or empty.
 */
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
  // Default the SES template stage from the runtime environment.
  return environment === "production" ? "prod" : "dev";
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
    database: envOrThrow("DATABASE"),
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
};
