import type { Request, Response } from "express";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import {
  completeConnection,
  type CallbackOutcome,
} from "../../services/calendarConnection/calendarConnectionServices.js";
import { providerSlug } from "../../services/calendarConnection/providers/index.js";
import { parseProvider } from "./utils.js";

const redirectTarget = (outcome: CallbackOutcome, slug: string) => {
  const url = new URL(`${config.calendarSync!.appUrl}/calendar-sync/`);
  if (outcome.ok) {
    url.searchParams.set("connected", slug);
    url.searchParams.set("config", outcome.configId);
  } else {
    url.searchParams.set("error", outcome.error);
    if (outcome.configId) url.searchParams.set("config", outcome.configId);
  }
  return url.toString();
};

/** Always a redirect to the web app, never the token or the provider's own error text. */
export const handleGetConnectionCallback = async (req: Request, res: Response) => {
  const provider = parseProvider(req.params.provider);
  const slug = providerSlug(provider);

  let outcome: CallbackOutcome;
  try {
    outcome = await completeConnection(provider, {
      state: req.query.state,
      code: req.query.code,
      error: req.query.error,
    });
  } catch (error) {
    // Name and code only: a failed query's message carries its parameters, tokens included.
    logger.error("calendar_connection.callback_failed", {
      provider: slug,
      name: error instanceof Error ? error.name : "unknown",
      code: (error as { cause?: { code?: string } }).cause?.code,
    });
    outcome = { ok: false, error: "server_error" };
  }

  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, redirectTarget(outcome, slug));
};
