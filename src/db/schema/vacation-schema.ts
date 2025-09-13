import { pgTable, text, timestamp, date, index } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

export const vacation = pgTable(
  "vacation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull(),
    requestedDay: date("requested_day").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("requested_day_idx").on(table.requestedDay)]
);
