import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

/**
 * Billing owner sitting above `groups`, so "who pays" is decoupled from "who
 * manages a group". Exactly one org per user (unique index on ownerUserId).
 * Rows are created lazily by `ensureOrganizationForUser`; users with no
 * groups get no row.
 *
 * The owner is **not** stored in `organization_users` — that table holds
 * delegated admins only, so "is this user an org admin" is owner-or-row and
 * `isOrganizationAdmin` is the only correct way to ask.
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
    // The stored toggle alone does not make Sick day requestable: the benefit
    // is active only while the plan is paid, and it goes dormant — flag kept,
    // data kept — when the subscription lapses. See `isSickDayBenefitActive`.
    sickDayBenefitEnabled: boolean("sick_day_benefit_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("uq_organizations_owner_user_id").on(table.ownerUserId)]
);
