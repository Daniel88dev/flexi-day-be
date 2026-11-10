import { sql } from "drizzle-orm";
import { date, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { organizations } from "./organization-schema.js";

const utcDay = () =>
  date("day", { mode: "string" })
    .notNull()
    .default(sql`(date_trunc('day', now() AT TIME ZONE 'UTC'))::date`);

/**
 * `tools/call` requests over `/mcp` per organization and UTC day, against the
 * daily AI connection limit. Refused calls are not counted.
 */
export const aiConnectionDailyCalls = pgTable(
  "ai_connection_daily_calls",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: utcDay(),
    calls: integer("calls").notNull().default(0),
    /** The first call the daily AI connection limit refused that day; `null` while under it. */
    limitReachedAt: timestamp("limit_reached_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.day] })]
);

/** The same count per member, against the member daily limit. */
export const aiConnectionMemberDailyCalls = pgTable(
  "ai_connection_member_daily_calls",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: utcDay(),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.day, table.userId] })]
);
