/**
 * Sentry's `tracesSampler`, kept free of app imports because `instrument.ts`
 * loads it before the app graph. `config.ts` parses the same rates, so a bad
 * value refuses to boot.
 */

export type TraceRates = { default: number; mcp: number; assistant: number };

type Env = Record<string, string | undefined>;

const rate = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 to 1`);
  }
  return value;
};

export const parseTraceRates = (env: Env): TraceRates => ({
  default: rate(env, "SENTRY_TRACES_SAMPLE_RATE", 0.2),
  mcp: rate(env, "SENTRY_TRACES_MCP_RATE", 0.05),
  assistant: rate(env, "SENTRY_TRACES_ASSISTANT_RATE", 1),
});

type SamplingContext = {
  name?: string;
  attributes?: Record<string, unknown>;
  parentSampled?: boolean;
  inheritOrSampleWith: (fallback: number) => number;
};

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * `/health` never; `/mcp` and the Assistant (chat API and webhook) at their own
 * rates; OAuth and discovery at the default rate; all three ignore the caller's
 * trace headers, so an outside client can't raise its own sampling. Everything
 * else inherits. The SDK names a server span by its method alone and puts the
 * path, without the query, in `url.path` (T-727 spike).
 */
export const createTracesSampler =
  (rates: TraceRates) =>
  ({ attributes, inheritOrSampleWith }: SamplingContext): number => {
    const raw = attributes?.["url.path"];
    const path = typeof raw === "string" ? raw : "";
    if (path === "/health") return 0;
    if (under(path, "/mcp")) return rates.mcp;
    if (under(path, "/api/assistant") || path === "/api/webhooks/anthropic") {
      return rates.assistant;
    }
    if (under(path, "/api/auth/oauth2") || under(path, "/.well-known")) return rates.default;
    return inheritOrSampleWith(rates.default);
  };
