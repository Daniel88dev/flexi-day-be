import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { requirePaddle } from "../../utils/paddle.js";
import { PLAN_LIMITS } from "../../services/billing/entitlements.js";
import {
  derivePlanFromItems,
  planPriceId,
  slotPriceId,
} from "../../services/billing/paddleCatalog.js";
import { billingCycle, subscriptionPlan } from "../../db/schema/subscription-schema.js";
import type { ValidatedChangePlanType } from "../../services/billing/types.js";
import { requireOwnedActiveSubscription } from "./handlePatchSlots.js";
import { logger } from "../../middleware/logger.js";

const services = createDBServices();

/** Pro ⇄ Enterprise and monthly ⇄ yearly on the existing subscription. */
export const handlePostChangePlan = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { paddle, paddleConfig } = requirePaddle();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedChangePlanType = req.body;

  const { organizationId, subscription } = await requireOwnedActiveSubscription(auth.userId);

  const newPlan = data.plan === "ENTERPRISE" ? subscriptionPlan.Enterprise : subscriptionPlan.Pro;
  const newCycle = data.billingCycle === "YEARLY" ? billingCycle.Yearly : billingCycle.Monthly;

  if (newPlan === subscription.plan && newCycle === subscription.billingCycle) {
    return res
      .status(200)
      .json({ plan: data.plan, billingCycle: data.billingCycle, changed: false });
  }

  // A downgrade may allow fewer extra slots than are currently held — clamp
  // rather than reject, so Enterprise → Pro is always possible in one step.
  const keptSlots = Math.min(subscription.extraGroupSlots, PLAN_LIMITS[data.plan].maxExtraSlots);

  const items = [
    { priceId: planPriceId(paddleConfig.prices, newPlan, newCycle), quantity: 1 },
    ...(keptSlots > 0
      ? [{ priceId: slotPriceId(paddleConfig.prices, newCycle), quantity: keptSlots }]
      : []),
  ];

  const updated = await paddle.subscriptions.update(subscription.paddleSubscriptionId, {
    items,
    prorationBillingMode: "prorated_immediately",
  });

  const derived = derivePlanFromItems(
    paddleConfig.prices,
    updated.items.map((item) => ({ priceId: item.price?.id, quantity: item.quantity }))
  );
  if (derived) {
    await services.billing.upsertSubscription(organizationId, derived);
  } else {
    // Paddle accepted the change but returned prices outside our catalog.
    // Persisting the intended state is better than leaving the row on the old
    // plan indefinitely — the next subscription.updated webhook still wins.
    logger.error("change-plan: Paddle returned items outside the price catalog", {
      organizationId,
      paddleSubscriptionId: subscription.paddleSubscriptionId,
      priceIds: updated.items.map((item) => item.price?.id),
    });
    await services.billing.upsertSubscription(organizationId, {
      plan: newPlan,
      billingCycle: newCycle,
      extraGroupSlots: keptSlots,
    });
  }

  return res.status(200).json({
    plan: derived?.plan ?? newPlan,
    billingCycle: derived?.billingCycle ?? newCycle,
    extraGroupSlots: derived?.extraGroupSlots ?? keptSlots,
    changed: true,
  });
};
