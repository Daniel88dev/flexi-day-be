import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  jsonb,
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
    /** The session's context after its latest settled step; the chat closes at the length ceiling. */
    contextTokens: integer("context_tokens").notNull().default(0),
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
    /**
     * Tool lines: who wrote the free text (notes, event titles) the result
     * carried. A card later in the turn names the ones other than the user.
     */
    textAuthors: jsonb("text_authors").$type<{ userId: string | null; name: string }[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_assistant_chat_messages_chat").on(table.chatId, table.seq),
    uniqueIndex("uq_assistant_chat_messages_event")
      .on(table.chatId, table.eventId)
      .where(sql`${table.eventId} IS NOT NULL`),
  ]
);

/**
 * Anthropic sessions to delete. Written in the transaction that deletes or
 * closes their chat, removed once the driver deleted the session, so a
 * failed delete is retried by the nightly tick.
 */
export const assistantSessionDeletions = pgTable("assistant_session_deletions", {
  sessionId: text("session_id").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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

export const pendingActionStatuses = ["open", "confirmed", "declined", "not_taken"] as const;
export type PendingActionStatus = (typeof pendingActionStatuses)[number];
export const pendingActionStatusEnum = pgEnum(
  "assistant_pending_action_status",
  pendingActionStatuses
);

/**
 * A write the Assistant asked for, waiting on the user's confirmation card:
 * the tool, its validated arguments and the preview the card shows. Nothing
 * runs until confirm, which runs these exact arguments with fresh guards.
 */
export const assistantPendingActions = pgTable(
  "assistant_pending_actions",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => assistantChats.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    /** The `requires_action` idle that asked for it: the round its answer is sent with. */
    roundEventId: text("round_event_id").notNull(),
    /** The `agent.custom_tool_use` event this card answers. */
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    /** The tool's `WritePreview`, user-written strings plain. */
    preview: jsonb("preview").$type<Record<string, unknown>>().notNull(),
    /** People other than the user whose notes the Assistant read earlier in the turn. */
    authorNames: jsonb("author_names").$type<string[]>().notNull().default([]),
    status: pendingActionStatusEnum("status").notNull().default("open"),
    /** The write's result once confirmed, user-written strings plain. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    /** The last confirm the guards refused; the card stays open to try again. */
    error: jsonb("error").$type<{ message: string; code: string | null }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_assistant_pending_actions_tool_use").on(table.chatId, table.toolUseId),
    index("idx_assistant_pending_actions_chat_status").on(table.chatId, table.status),
  ]
);

/**
 * Tool results not sent to the session yet: a round waits until every card
 * in it is decided, and a round the meter refused waits for the user's next
 * admitted message, which carries them.
 */
export const assistantHeldAnswers = pgTable(
  "assistant_held_answers",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => assistantChats.id, { onDelete: "cascade" }),
    roundEventId: text("round_event_id").notNull(),
    toolUseId: text("tool_use_id").notNull(),
    text: text("text").notNull(),
    isError: boolean("is_error").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("uq_assistant_held_answers_tool_use").on(table.chatId, table.toolUseId)]
);
