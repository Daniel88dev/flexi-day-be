import { boolean, check, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth-schema.js";
import { groups } from "./group-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum changesType {
  Group = "GROUP",
  GroupUser = "GROUP_USER",
  Vacation = "VACATION",
  UserYearQuotas = "USER_YEAR_QUOTAS",
}

export const changesEnum = pgEnum("changes_type", enumToPgEnum(changesType));

export const changesSchema = pgTable(
  "changes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    changeType: changesEnum("change_type").notNull(),
    changeDetail: text("change_detail").notNull(),
    // A NULL actor with `changingUserDeleted` false means the scheduled quota
    // rollover wrote this row. The flag marks rows whose actor was cleared by
    // an account deletion from before Deleted accounts kept their user row;
    // deletion now leaves the actor in place. The FK keeps no ON DELETE: any
    // path that deletes an actor fails rather than leaving a bare NULL behind.
    changingUserId: text("changing_user_id").references(() => user.id),
    changingUserDeleted: boolean("changing_user_deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [
    check(
      "changes_deleted_actor_has_no_id_chk",
      sql`NOT (${table.changingUserDeleted} AND ${table.changingUserId} IS NOT NULL)`
    ),
  ]
);
