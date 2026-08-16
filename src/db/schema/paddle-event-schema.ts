import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Webhook idempotency ledger: the handler inserts the event id FIRST and
 * treats a conflict as "already processed" — Paddle retries aggressively.
 */
export const paddleEvents = pgTable("paddle_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});
