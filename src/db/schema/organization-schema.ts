import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

/**
 * Billing owner sitting above `groups`, so "who pays" is decoupled from "who
 * manages a group". Phase 1: exactly one org per user (unique index on
 * ownerUserId) and membership stays implicit (owner only) — an
 * `organization_users` table can be added later without touching `groups`.
 * Rows are created lazily by `ensureOrganizationForUser`; users with no
 * groups get no row.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id),
    billingEmail: text("billing_email").notNull(),
    paddleCustomerId: text("paddle_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("uq_organizations_owner_user_id").on(table.ownerUserId)]
);
