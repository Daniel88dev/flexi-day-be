import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { sql } from "drizzle-orm";

export const userYearQuotas = pgTable(
  "user_year_quotas",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    relatedYear: varchar("related_year", { length: 4 }).notNull(),
    vacationDays: integer("vacation_days").notNull().default(20),
    homeOfficeDays: integer("home_office_days").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_year_quotas_user_year_uidx").on(
      table.userId,
      table.relatedYear
    ),
    check(
      "user_year_quotas_related_year_chk",
      sql`${table.relatedYear} ~ '^[0-9]{4}$'`
    ),
    "user_year_quotas_related_year_range_chk",
    sql`${table.relatedYear}::int BETWEEN 2025 AND 2100`,
  ]
);
