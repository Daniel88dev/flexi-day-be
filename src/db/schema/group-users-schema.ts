import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { group } from "./group-schema.js";
import { user } from "./auth-schema.js";

export const groupUsers = pgTable("group_users", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => group.id),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  confirmEmail: timestamp("confirm_email"),
  viewAccess: boolean("view_access").notNull().default(false),
  adminAccess: boolean("admin_access").notNull().default(false),
  controlledUser: boolean("controlled_user").notNull().default(false),
  deleted: timestamp("deleted"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => new Date())
    .notNull(),
});
