import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { isNull } from "drizzle-orm";

export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey(),
    groupName: text("group_name").notNull(),
    defaultVacationDays: integer("default_vacation_days").notNull().default(20),
    defaultHomeOfficeDays: integer("default_home_office_days").notNull().default(0),
    // JS `Date.getUTCDay()` numbers (0=Sun … 6=Sat); default Mon–Fri.
    workingDays: integer("working_days").array().notNull().default([1, 2, 3, 4, 5]),
    managerUserId: text("manager_user_id")
      .notNull()
      .references(() => user.id),
    mainApprovalUser: text("main_approval_user").references(() => user.id),
    tempApprovalUser: text("temp_approval_user").references(() => user.id),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("idx_groups_deleted_at_active").on(table.deletedAt).where(isNull(table.deletedAt)),
  ]
);
