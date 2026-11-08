import Anthropic from "@anthropic-ai/sdk";
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

/** One SDK client for the process, built from `ANTHROPIC_API_KEY`; 503 without one. */
export const anthropicClient = (): Anthropic => {
  const apiKey = config.assistant.apiKey;
  if (!apiKey) throw assistantUnavailable();
  client ??= new Anthropic({ apiKey, maxRetries: 2 });
  return client;
};
