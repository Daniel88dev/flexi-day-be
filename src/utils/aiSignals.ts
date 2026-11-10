import * as Sentry from "@sentry/node";
import { logger } from "../middleware/logger.js";

/**
 * The Assistant's and `/mcp`'s operational signals: one log line each, plus an
 * application metric for the ones an alert counts or sums. Unsampled, unlike
 * spans, so the alerts in docs/terraform.md sit on them. Each signal lists the
 * attributes it may carry (ids, enums, numbers); anything else is dropped,
 * because chat text, tool arguments and results, names and emails never leave
 * the process (docs/invariants.md).
 */
type Spec = {
  level: "info" | "warn" | "error";
  attributes: readonly string[];
  metric?: { kind: "count" | "usd"; attributes: readonly string[] };
};

export const AI_SIGNALS = {
  "assistant.cost_usd": {
    level: "info",
    attributes: ["organizationId", "purpose", "microUsd"],
    metric: { kind: "usd", attributes: ["purpose"] },
  },
  "assistant.screen_failed": {
    level: "warn",
    attributes: ["chatId", "purpose", "reason", "error"],
    metric: { kind: "count", attributes: ["purpose", "reason"] },
  },
  "assistant.session_error": {
    level: "warn",
    attributes: ["chatId", "errorType", "retryStatus"],
    metric: { kind: "count", attributes: ["errorType", "retryStatus"] },
  },
  "assistant.webhook_rejected": {
    level: "warn",
    attributes: ["reason"],
    metric: { kind: "count", attributes: ["reason"] },
  },
  "assistant.webhook_missed": { level: "warn", attributes: ["chatId"] },
  "mcp.daily_limit_reached": { level: "info", attributes: ["organizationId", "limit"] },
  "assistant.weekly_limit_reached": { level: "info", attributes: ["organizationId", "purpose"] },
  "assistant.provider_refused": { level: "error", attributes: ["operation"] },
  "session.budget_reached": { level: "warn", attributes: ["chatId"] },
  "agent.thread_context_compacted": { level: "warn", attributes: ["chatId"] },
} as const satisfies Record<string, Spec>;

export type AiSignal = keyof typeof AI_SIGNALS;

type Value = string | number;
type AttributesOf<N extends AiSignal> = {
  [K in (typeof AI_SIGNALS)[N]["attributes"][number]]?: Value;
};

const pick = (from: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = from[key];
      return typeof value === "string" || typeof value === "number" ? [[key, value]] : [];
    })
  );

export const aiSignal = <N extends AiSignal>(name: N, attributes: AttributesOf<N>): void => {
  const spec: Spec = AI_SIGNALS[name];
  const values = attributes as Record<string, unknown>;
  logger[spec.level](name, pick(values, spec.attributes));
  if (!spec.metric) return;
  const metricAttributes = pick(values, spec.metric.attributes);
  if (spec.metric.kind === "count") {
    Sentry.metrics.count(name, 1, { attributes: metricAttributes });
  } else {
    const microUsd = typeof values.microUsd === "number" ? values.microUsd : 0;
    Sentry.metrics.distribution(name, microUsd / 1_000_000, {
      unit: "usd",
      attributes: metricAttributes,
    });
  }
};
