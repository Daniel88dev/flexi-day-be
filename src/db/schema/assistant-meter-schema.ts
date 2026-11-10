import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { assistantChats } from "./assistant-schema.js";
import { user } from "./auth-schema.js";
import { organizations } from "./organization-schema.js";

export const assistantCallPurposes = ["main", "screen"] as const;
export type AssistantCallPurpose = (typeof assistantCallPurposes)[number];
export const assistantCallPurposeEnum = pgEnum("assistant_call_purpose", assistantCallPurposes);

export const assistantCallStatuses = ["reserved", "settled"] as const;
export type AssistantCallStatus = (typeof assistantCallStatuses)[number];
export const assistantCallStatusEnum = pgEnum("assistant_call_status", assistantCallStatuses);

/**
 * The meter's ledger: one row per metered step, meaning each send into a
 * session (a user message, or the tool results that resume it) and each
 * screen call. No content. A row is reserved at its worst case before the
 * step and settled from the session's usage at the next idle; "used this
 * week" is settled plus reserved.
 */
export const assistantModelCalls = pgTable(
  "assistant_model_calls",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Erasing the account strips the link and keeps the cost. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Deleting the chat keeps the cost. */
    chatId: text("chat_id").references(() => assistantChats.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    /** The first event this step sent into the session; `null` until sent, and on screen rows. */
    eventId: text("event_id"),
    /**
     * What claimed the step, so concurrent advances of one turn reserve it once:
     * the idle event that asked for the tool results. `null` for user messages and screens.
     */
    triggerEventId: text("trigger_event_id"),
    /** Monday of the UTC week, from the database clock. */
    weekStart: date("week_start", { mode: "string" })
      .notNull()
      .default(sql`(date_trunc('week', now() AT TIME ZONE 'UTC'))::date`),
    purpose: assistantCallPurposeEnum("purpose").notNull(),
    modelId: text("model_id").notNull(),
    priceVersion: text("price_version").notNull(),
    status: assistantCallStatusEnum("status").notNull().default("reserved"),
    reservedMicroUsd: bigint("reserved_micro_usd", { mode: "number" }).notNull(),
    settledMicroUsd: bigint("settled_micro_usd", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    outputTokens: integer("output_tokens"),
    /** Managed Agents reports thinking inside output; `null` until a source splits it out. */
    thinkingTokens: integer("thinking_tokens"),
    stopReason: text("stop_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_assistant_model_calls_org_week").on(table.organizationId, table.weekStart),
    index("idx_assistant_model_calls_session").on(table.sessionId),
    index("idx_assistant_model_calls_open")
      .on(table.createdAt)
      .where(sql`${table.status} = 'reserved'`),
    uniqueIndex("uq_assistant_model_calls_trigger")
      .on(table.sessionId, table.triggerEventId)
      .where(sql`${table.triggerEventId} IS NOT NULL`),
  ]
);
