import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { user } from "./auth-schema.js";

export const assistantTurnStatuses = ["idle", "running"] as const;
export type AssistantTurnStatus = (typeof assistantTurnStatuses)[number];
export const assistantTurnStatusEnum = pgEnum("assistant_turn_status", assistantTurnStatuses);

/**
 * What one display record row is: the user's text, the Assistant's final text,
 * a tool activity line, or a fixed notice (an error, later refusals) written by
 * us rather than the model.
 */
export const assistantMessageKinds = ["user", "assistant", "tool", "notice"] as const;
export type AssistantMessageKind = (typeof assistantMessageKinds)[number];
export const assistantMessageKindEnum = pgEnum("assistant_message_kind", assistantMessageKinds);

/**
 * A member's chat with the Assistant in one organization. The Anthropic
 * session is the model's memory; the display record below is ours, and the
 * authority for retention and deletes.
 */
export const assistantChats = pgTable(
  "assistant_chats",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** From the first message; `null` until one is sent. */
    title: text("title"),
    /** The driver's session, created with the first message. */
    sessionId: text("session_id"),
    /** The agent version the session is pinned to; `null` on the fake driver. */
    agentVersion: integer("agent_version"),
    turnStatus: assistantTurnStatusEnum("turn_status").notNull().default("idle"),
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    /** The session event the running turn started at; reconnects list events after it. */
    turnStartEventId: text("turn_start_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_assistant_chats_user_last_message").on(table.userId, table.lastMessageAt),
    index("idx_assistant_chats_organization").on(table.organizationId),
    // The webhook names a session, never a chat.
    uniqueIndex("uq_assistant_chats_session")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    // One running turn per user, whichever chat it is in.
    uniqueIndex("uq_assistant_chats_running_turn_per_user")
      .on(table.userId)
      .where(sql`${table.turnStatus} = 'running'`),
  ]
);

/** The display record: what the chat shows, in order. */
export const assistantChatMessages = pgTable(
  "assistant_chat_messages",
  {
    id: text("id").primaryKey(),
    /** Insertion order, the display order. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    chatId: text("chat_id")
      .notNull()
      .references(() => assistantChats.id, { onDelete: "cascade" }),
    kind: assistantMessageKindEnum("kind").notNull(),
    /** User or Assistant text; `null` on tool lines and notices. */
    text: text("text"),
    /** Tool lines: the tool's name and how the run ended (`ok`, `refused`, ...). */
    toolName: text("tool_name"),
    toolOutcome: text("tool_outcome"),
    /** Notices: a fixed message key the web app translates. */
    code: text("code"),
    /** The session event this row records; a replayed step finds it and writes nothing. */
    eventId: text("event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_assistant_chat_messages_chat").on(table.chatId, table.seq),
    uniqueIndex("uq_assistant_chat_messages_event")
      .on(table.chatId, table.eventId)
      .where(sql`${table.eventId} IS NOT NULL`),
  ]
);

/** Anthropic webhook deliveries already handled, by event id; a retry or replay finds its row and stops. */
export const assistantWebhookEvents = pgTable("assistant_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

export const assistantRejectionReasons = ["off_topic", "attack"] as const;
export type AssistantRejectionReason = (typeof assistantRejectionReasons)[number];
export const assistantRejectionReasonEnum = pgEnum(
  "assistant_rejection_reason",
  assistantRejectionReasons
);

/**
 * One message the screen kept from the session, counted per person per week
 * on the usage page. No content: the message itself stays in the display
 * record, and deleting the chat keeps the count.
 */
export const assistantRejectedTurns = pgTable(
  "assistant_rejected_turns",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chatId: text("chat_id").references(() => assistantChats.id, { onDelete: "set null" }),
    reason: assistantRejectionReasonEnum("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_assistant_rejected_turns_organization_created").on(
      table.organizationId,
      table.createdAt
    ),
  ]
);
