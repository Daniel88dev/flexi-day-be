import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum subscriptionPlan {
  Pro = "PRO",
  Enterprise = "ENTERPRISE",
}

export enum subscriptionStatus {
  Active = "active",
  Trialing = "trialing",
  PastDue = "past_due",
  Paused = "paused",
  Canceled = "canceled",
}

export enum billingCycle {
  Monthly = "MONTHLY",
  Yearly = "YEARLY",
}

/** Grandfathering, comped accounts and Enterprise Custom — see `manual*` columns. */
export enum manualPlanOverride {
  Free = "FREE",
  Pro = "PRO",
  Enterprise = "ENTERPRISE",
  Custom = "CUSTOM",
}

export const subscriptionPlanEnum = pgEnum("subscription_plan", enumToPgEnum(subscriptionPlan));
export const subscriptionStatusEnum = pgEnum(
  "subscription_status",
  enumToPgEnum(subscriptionStatus)
);
export const billingCycleEnum = pgEnum("billing_cycle", enumToPgEnum(billingCycle));
export const manualPlanOverrideEnum = pgEnum(
  "manual_plan_override",
  enumToPgEnum(manualPlanOverride)
);

/**
 * One row per organization; absence means Free (the `user_settings` precedent
 * — readers treat a missing row as defaults). Grace expiry is derived at read
 * time by `resolveEntitlements`; there is no cron sweep.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    paddleSubscriptionId: text("paddle_subscription_id"),
    paddleCustomerId: text("paddle_customer_id"),
    plan: subscriptionPlanEnum("plan"),
    status: subscriptionStatusEnum("status"),
    billingCycle: billingCycleEnum("billing_cycle"),
    extraGroupSlots: integer("extra_group_slots").notNull().default(0),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    // Wins over Paddle state while `manualPlanUntil` is null or in the future.
    manualPlanOverride: manualPlanOverrideEnum("manual_plan_override"),
    manualMaxGroups: integer("manual_max_groups"),
    manualMaxMembersPerGroup: integer("manual_max_members_per_group"),
    manualPlanUntil: timestamp("manual_plan_until", { withTimezone: true }),
    // `occurred_at` of the newest Paddle event applied to this row. Paddle
    // does not guarantee delivery order, so an event older than this is
    // discarded rather than allowed to resurrect stale state.
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_subscriptions_organization_id").on(table.organizationId),
    // `getSubscriptionByPaddleId` runs on every payment_failed event and on
    // any event whose custom_data lost the organization id.
    index("idx_subscriptions_paddle_subscription_id").on(table.paddleSubscriptionId),
  ]
);
