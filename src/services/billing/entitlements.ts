import {
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import type { Subscription } from "./types.js";

export const PLAN_LIMITS = {
  FREE: { groups: 3, membersPerGroup: 10, maxExtraSlots: 0 },
  PRO: { groups: 5, membersPerGroup: 25, maxExtraSlots: 4 },
  ENTERPRISE: { groups: 20, membersPerGroup: 100, maxExtraSlots: 20 },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;

export type Entitlements = {
  plan: PlanName | "CUSTOM";
  /** Plan groups + purchased extra slots (or the manual override). */
  maxGroups: number;
  maxMembersPerGroup: number;
  /** False once grace has expired — groups over the limit become read-only. */
  writable: boolean;
  graceEndsAt: string | null;
};

const freeEntitlements = (writable: boolean): Entitlements => ({
  plan: "FREE",
  maxGroups: PLAN_LIMITS.FREE.groups,
  maxMembersPerGroup: PLAN_LIMITS.FREE.membersPerGroup,
  writable,
  graceEndsAt: null,
});

const paidEntitlements = (
  plan: subscriptionPlan,
  extraGroupSlots: number,
  graceEndsAt: Date | null
): Entitlements => {
  const limits = plan === subscriptionPlan.Enterprise ? PLAN_LIMITS.ENTERPRISE : PLAN_LIMITS.PRO;
  // Clamped to the plan's ceiling: the checkout and slot routes enforce it,
  // but a quantity edited directly in the Paddle dashboard reaches us through
  // the webhook without ever passing those.
  const slots = Math.min(Math.max(0, extraGroupSlots), limits.maxExtraSlots);
  return {
    plan: plan === subscriptionPlan.Enterprise ? "ENTERPRISE" : "PRO",
    maxGroups: limits.groups + slots,
    maxMembersPerGroup: limits.membersPerGroup,
    writable: true,
    graceEndsAt: graceEndsAt ? graceEndsAt.toISOString() : null,
  };
};

/**
 * Pure resolver from a subscription row (or its absence, which means Free) to
 * effective limits. Grace expiry is derived from `now` at read time — there is
 * deliberately no cron sweep flipping state.
 */
export const resolveEntitlements = (sub: Subscription | null, now: Date): Entitlements => {
  if (!sub) return freeEntitlements(true);

  // Manual override wins over everything while it has not expired:
  // grandfathering, comped accounts and Enterprise Custom.
  const overrideActive =
    sub.manualPlanOverride !== null && (sub.manualPlanUntil === null || sub.manualPlanUntil > now);

  if (overrideActive && sub.manualPlanOverride) {
    switch (sub.manualPlanOverride) {
      case manualPlanOverride.Free:
        // An explicit downgrade-to-free: enforce read-only over Free limits.
        return freeEntitlements(false);
      case manualPlanOverride.Pro:
      case manualPlanOverride.Enterprise: {
        const limits =
          sub.manualPlanOverride === manualPlanOverride.Enterprise
            ? PLAN_LIMITS.ENTERPRISE
            : PLAN_LIMITS.PRO;
        return {
          plan: sub.manualPlanOverride === manualPlanOverride.Enterprise ? "ENTERPRISE" : "PRO",
          maxGroups: sub.manualMaxGroups ?? limits.groups,
          maxMembersPerGroup: sub.manualMaxMembersPerGroup ?? limits.membersPerGroup,
          writable: true,
          graceEndsAt: null,
        };
      }
      case manualPlanOverride.Custom:
        return {
          plan: "CUSTOM",
          maxGroups: sub.manualMaxGroups ?? PLAN_LIMITS.ENTERPRISE.groups,
          maxMembersPerGroup:
            sub.manualMaxMembersPerGroup ?? PLAN_LIMITS.ENTERPRISE.membersPerGroup,
          writable: true,
          graceEndsAt: null,
        };
    }
  }

  if (!sub.plan || !sub.status) return freeEntitlements(true);

  switch (sub.status) {
    case subscriptionStatus.Active:
    case subscriptionStatus.Trialing:
      return paidEntitlements(sub.plan, sub.extraGroupSlots, null);
    case subscriptionStatus.PastDue:
    case subscriptionStatus.Canceled:
    case subscriptionStatus.Paused: {
      // Paid limits survive through the grace window; after it (or when no
      // grace was granted) the org drops to Free and over-limit groups lock.
      if (sub.graceEndsAt && sub.graceEndsAt > now) {
        return paidEntitlements(sub.plan, sub.extraGroupSlots, sub.graceEndsAt);
      }
      return freeEntitlements(false);
    }
  }
};
