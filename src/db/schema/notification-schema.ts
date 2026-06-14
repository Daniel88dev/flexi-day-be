import { index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum notificationType {
  ApprovalRequested = "approval_requested",
  ApprovalDecided = "approval_decided",
  CalendarConflict = "calendar_conflict",
  BalanceLow = "balance_low",
}

export const notificationTypeEnum = pgEnum(
  "notification_type",
  enumToPgEnum(notificationType)
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("notifications_user_id_idx").on(table.userId),
    index("notifications_user_unread_idx").on(table.userId, table.readAt),
  ]
);
