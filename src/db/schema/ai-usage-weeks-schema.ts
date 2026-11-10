import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { organizations } from "./organization-schema.js";

/**
 * A finished week's Usage per person, rolled up from the ledger and the daily
 * AI connection counters by the nightly tick and kept 180 days. Erase strips
 * the user and keeps the amount, so several rows of one week can have none.
 */
export const aiUsageUserWeeks = pgTable(
  "ai_usage_user_weeks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    usedMicroUsd: bigint("used_micro_usd", { mode: "number" }).notNull().default(0),
    aiConnectionCalls: integer("ai_connection_calls").notNull().default(0),
  },
  (table) => [
    index("idx_ai_usage_user_weeks_org_week").on(table.organizationId, table.weekStart),
    uniqueIndex("uq_ai_usage_user_weeks_person")
      .on(table.organizationId, table.weekStart, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
  ]
);

/** A finished week's Usage for the whole organization, kept for the organization's life. */
export const aiUsageOrganizationWeeks = pgTable(
  "ai_usage_organization_weeks",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    usedMicroUsd: bigint("used_micro_usd", { mode: "number" }).notNull().default(0),
    /** When the week's running total passed the Weekly limit then in force; `null` if it never did. */
    limitReachedAt: timestamp("limit_reached_at", { withTimezone: true }),
    aiConnectionCalls: integer("ai_connection_calls").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.weekStart] })]
);
