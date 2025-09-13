import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { groups } from "./group-schema.js";
import { user } from "./auth-schema.js";
import { sql } from "drizzle-orm";

export const groupUsers = pgTable(
  "group_users",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emailConfirmedAt: timestamp("email_confirmed_at"),
    viewAccess: boolean("view_access").notNull().default(false),
    adminAccess: boolean("admin_access").notNull().default(false),
    controlledUser: boolean("controlled_user").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    uniqActiveMembership: uniqueIndex("group_users_group_id_user_id_uniq")
      .on(table.groupId, table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
    idxGroupId: index("idx_group_users_group_id").on(table.groupId),
    idxUserId: index("idx_group_users_user_id").on(table.userId),
  })
);
