import { eq, lt } from "drizzle-orm";
import { db } from "../../db/db.js";
import { assistantWebhookEvents } from "../../db/schema/assistant-schema.js";
import { advanceIdledSession } from "./turnServices.js";

/** A verified Anthropic webhook delivery, the fields we read. */
export type AssistantWebhookEvent = { id: string; data: { id: string; type: string } };

export type AssistantWebhookOutcome = "advanced" | "ignored" | "duplicate";

const IDLED = "session.status_idled";

/** How long a handled delivery's event id is kept: well past the last retry of a delivery. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Handles one verified delivery. Only `session.status_idled` does anything:
 * it advances the session's chat, once per event id. A failed advance forgets
 * the event id, so Anthropic's retry runs it again.
 */
export const handleAssistantWebhook = async (
  event: AssistantWebhookEvent
): Promise<AssistantWebhookOutcome> => {
  if (event.data.type !== IDLED) return "ignored";
  const fresh = await db
    .insert(assistantWebhookEvents)
    .values({ eventId: event.id, eventType: event.data.type })
    .onConflictDoNothing()
    .returning({ eventId: assistantWebhookEvents.eventId });
  if (fresh.length === 0) return "duplicate";
  try {
    return await advanceIdledSession(event.data.id);
  } catch (error) {
    await db.delete(assistantWebhookEvents).where(eq(assistantWebhookEvents.eventId, event.id));
    throw error;
  }
};

/** Deletes the event ids of deliveries handled more than `WEBHOOK_EVENT_RETENTION_DAYS` ago. */
export const purgeWebhookEvents = async (now = new Date()): Promise<number> => {
  const cutoff = new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS);
  const deleted = await db
    .delete(assistantWebhookEvents)
    .where(lt(assistantWebhookEvents.receivedAt, cutoff))
    .returning({ eventId: assistantWebhookEvents.eventId });
  return deleted.length;
};
