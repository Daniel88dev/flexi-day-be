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
  changingUserId: text("changing_user_id")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date()),
});
