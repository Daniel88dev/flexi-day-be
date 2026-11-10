import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/node";
import { config } from "../../../config.js";
import AppError from "../../../utils/appError.js";

export const assistantUnavailable = () =>
  new AppError({
    message: "The Assistant is unavailable right now",
    code: 503,
    logging: true,
    publicContext: { code: "ASSISTANT_UNAVAILABLE" },
  });

let client: Anthropic | null = null;

/**
 * The SDK's own OpenTelemetry spans and its `traceparent` are off: Sentry's
 * wrapper gives the screen its `gen_ai.chat` span (model and tokens, never the
 * prompt or the answer) and Sentry writes the one `traceparent` (T-727 spike).
 * Sentry's automatic Anthropic integration covers SDK versions below 1 only.
 */
const buildAnthropicClient = (apiKey: string) =>
  Sentry.instrumentAnthropicAiClient(
    new Anthropic({
      apiKey,
      maxRetries: 2,
      openTelemetry: { traces: false, propagation: false },
    }),
    { recordInputs: false, recordOutputs: false }
  );

/** One SDK client for the process, built from `ANTHROPIC_API_KEY`; 503 without one. */
export const anthropicClient = (): Anthropic => {
  const apiKey = config.assistant.apiKey;
  if (!apiKey) throw assistantUnavailable();
  client ??= buildAnthropicClient(apiKey);
  return client;
};
