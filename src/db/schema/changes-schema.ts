import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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

export const changesSchema = pgTable("changes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  changeType: changesEnum("change_type").notNull(),
  changeDetail: text("change_detail").notNull(),
  // NULL means the scheduled quota rollover wrote this row rather than a
  // person. The FK has no ON DELETE, so a real actor can never become NULL —
  // readers can treat NULL as "system" without ambiguity.
  changingUserId: text("changing_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date()),
});
