import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
