import type { Request, Response } from "express";
import { Webhook } from "standardwebhooks";
import { config } from "../../config.js";
import { validateAnthropicWebhook } from "../../services/assistant/types.js";
import { handleAssistantWebhook } from "../../services/assistant/webhookServices.js";
import AppError from "../../utils/appError.js";
import { errorName } from "../../utils/errorName.js";
import { aiSignal } from "../../utils/aiSignals.js";

const headerOf = (req: Request, name: string): string => {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

/**
 * Anthropic's webhook. Reached before body parsing and outside session auth;
 * the Standard Webhooks signature over the raw body is the only credential.
 * Without `ANTHROPIC_WEBHOOK_SECRET` the route does not exist.
 */
export const handleAnthropicWebhook = async (req: Request, res: Response) => {
  const secret = config.assistant.webhookSecret;
  if (!secret) throw new AppError({ message: "Not found", code: 404 });

  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let verified: unknown;
  try {
    verified = new Webhook(secret).verify(body, {
      "webhook-id": headerOf(req, "webhook-id"),
      "webhook-timestamp": headerOf(req, "webhook-timestamp"),
      "webhook-signature": headerOf(req, "webhook-signature"),
    });
  } catch (error) {
    aiSignal("assistant.webhook_rejected", { reason: errorName(error) });
    throw new AppError({ message: "Invalid signature", code: 401 });
  }

  const payload = validateAnthropicWebhook.safeParse(verified);
  if (!payload.success) {
    aiSignal("assistant.webhook_rejected", { reason: "invalid_payload" });
    throw new AppError({ message: "Invalid payload", code: 400 });
  }
  res.status(200).json({ status: await handleAssistantWebhook(payload.data) });
};
