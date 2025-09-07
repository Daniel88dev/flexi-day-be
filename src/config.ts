import dotenv from "dotenv";
dotenv.config({ quiet: true });

type APIConfig = { port: number; env: "production" | "dev" | "test" };

type DBConfig = { database: string };

type AuthConfig = { secret: string; url: string };

type Config = {
  api: APIConfig;
  db: DBConfig;
  auth?: AuthConfig;
};

const VALID_ENVS = ["production", "dev", "test"] as const;
type NodeEnv = (typeof VALID_ENVS)[number];

/**
 * Retrieves the value of the given environment variable or throws an error if it is missing.
 *
 * @param key - The environment variable name to read from process.env
 * @returns The string value of the environment variable
 * @throws Error if the specified environment variable is not set or is an empty string
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
  throw new Error(
    `Invalid NODE_ENV: "${value}". Expected one of ${VALID_ENVS.join(", ")}`
  );
};

const environment = parseNodeEnv(envOrThrow("NODE_ENV"));

export const config: Config = {
  api: {
    port: (() => {
      const raw = envOrThrow("PORT");
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0)
        throw new Error(`Invalid PORT: "${raw}"`);
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
        }
      : undefined,
};
