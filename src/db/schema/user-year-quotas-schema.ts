import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

export const userYearQuotas = pgTable(
  "user_year_quotas",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
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
  ]
);
