import { sql } from "drizzle-orm";
import { boolean, check, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

/**
 * A user's birthday. Its own table rather than `user_settings` so the sync pull
 * has a row to ship and to tombstone. A removed birthday keeps the row with
 * month, day and year wiped and `deleted_at` set.
 */
export const userBirthdays = pgTable(
  "user_birthdays",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    month: smallint("month"),
    day: smallint("day"),
    year: smallint("year"),
    shared: boolean("shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "user_birthdays_tombstone_chk",
      sql`(${table.deletedAt} IS NULL AND ${table.month} IS NOT NULL AND ${table.day} IS NOT NULL)
        OR (${table.deletedAt} IS NOT NULL AND ${table.month} IS NULL AND ${table.day} IS NULL AND ${table.year} IS NULL)`
    ),
    check("user_birthdays_month_chk", sql`${table.month} BETWEEN 1 AND 12`),
    check("user_birthdays_day_chk", sql`${table.day} BETWEEN 1 AND 31`),
    check("user_birthdays_year_chk", sql`${table.year} >= 1900`),
  ]
);
