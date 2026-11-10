import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";
import { user } from "./auth-schema.js";

/** The owner's AI connections setting: what members' AI apps may do in the organization. */
export enum aiConnectionsLevel {
  Off = "off",
  Read = "read",
  Write = "write",
}

export const aiConnectionsLevelEnum = pgEnum(
  "ai_connections_level",
  enumToPgEnum(aiConnectionsLevel)
);

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
    // Owner-only and Enterprise-only to turn on. The kill switch and the plan
    // decide whether members reach it; this is only the owner's choice.
    assistantEnabled: boolean("assistant_enabled").notNull().default(false),
    assistantEnabledAt: timestamp("assistant_enabled_at", { withTimezone: true }),
    // Owner-only; any Paid plan to raise. A lapsed plan refuses every call but
    // keeps the setting and the grants.
    aiConnections: aiConnectionsLevelEnum("ai_connections")
      .notNull()
      .default(aiConnectionsLevel.Off),
    aiConnectionsChangedAt: timestamp("ai_connections_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("uq_organizations_owner_user_id").on(table.ownerUserId)]
);
