import type { PaddleConfig } from "../../config.js";
import { billingCycle, subscriptionPlan } from "../../db/schema/subscription-schema.js";

export const planPriceId = (
  prices: PaddleConfig["prices"],
  plan: subscriptionPlan,
  cycle: billingCycle
): string => {
  if (plan === subscriptionPlan.Enterprise) {
    return cycle === billingCycle.Yearly ? prices.enterpriseYearly : prices.enterpriseMonthly;
  }
  return cycle === billingCycle.Yearly ? prices.proYearly : prices.proMonthly;
};

/** Paddle requires all items on one subscription to share a billing period. */
export const slotPriceId = (prices: PaddleConfig["prices"], cycle: billingCycle): string =>
  cycle === billingCycle.Yearly ? prices.extraGroupYearly : prices.extraGroupMonthly;

export type DerivedPlanState = {
  plan: subscriptionPlan;
  billingCycle: billingCycle;
  extraGroupSlots: number;
};

/**
 * Re-derives plan, cycle and slot count from a Paddle subscription's items by
 * matching our six price ids — the webhook's source of truth. Returns
 * undefined when no known plan price is present (a foreign subscription).
 */
export const derivePlanFromItems = (
  prices: PaddleConfig["prices"],
  items: { priceId: string | undefined; quantity: number }[]
): DerivedPlanState | undefined => {
  let plan: subscriptionPlan | undefined;
  let cycle: billingCycle | undefined;
  let extraGroupSlots = 0;

  for (const item of items) {
    switch (item.priceId) {
      case prices.proMonthly:
        plan = subscriptionPlan.Pro;
        cycle = billingCycle.Monthly;
        break;
      case prices.proYearly:
        plan = subscriptionPlan.Pro;
        cycle = billingCycle.Yearly;
        break;
      case prices.enterpriseMonthly:
        plan = subscriptionPlan.Enterprise;
        cycle = billingCycle.Monthly;
        break;
      case prices.enterpriseYearly:
        plan = subscriptionPlan.Enterprise;
        cycle = billingCycle.Yearly;
        break;
      case prices.extraGroupMonthly:
      case prices.extraGroupYearly:
        extraGroupSlots += item.quantity;
        break;
      default:
        break;
    }
  }

  if (!plan || !cycle) return undefined;
  return { plan, billingCycle: cycle, extraGroupSlots };
};
