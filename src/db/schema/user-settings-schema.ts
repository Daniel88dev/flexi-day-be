import { boolean, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { groups } from "./group-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/** Whose leave the dashboard calendar shows by default. */
export enum dashboardScope {
  Mine = "MINE",
  Group = "GROUP",
}

export const dashboardScopeEnum = pgEnum("dashboard_scope", enumToPgEnum(dashboardScope));

/**
 * Per-user preferences. Deliberately a separate table rather than columns on
 * `user`, which better-auth owns and migrates.
 *
 * A missing row means "defaults" — every reader treats absence as
 * `emailNotifications: true`, so a user only gets a row once they change
 * something.
 */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  // Workflow mail only (approval requests, decisions, cancellations).
  // Account mail such as email confirmation ignores this flag.
  emailNotifications: boolean("email_notifications").notNull().default(true),
  dashboardScope: dashboardScopeEnum("dashboard_scope").notNull().default(dashboardScope.Mine),
  // Which group `GROUP` scope shows. Kept nullable and cleared on group
  // deletion; readers fall back to the personal calendar when it is null, so a
  // deleted group degrades instead of erroring.
  dashboardGroupId: text("dashboard_group_id").references(() => groups.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
