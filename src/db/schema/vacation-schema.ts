import { pgTable, text, timestamp, date, index } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { groups } from "./group-schema.js";

export const vacation = pgTable(
  "vacation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    requestedDay: date("requested_day").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("requested_day_idx").on(table.requestedDay),
    index("vacation_user_day_idx").on(table.userId, table.requestedDay),
  ]
);
