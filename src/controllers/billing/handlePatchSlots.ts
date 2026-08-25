import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { requirePaddle } from "../../utils/paddle.js";
import AppError from "../../utils/appError.js";
import { PLAN_LIMITS } from "../../services/billing/entitlements.js";
import {
  derivePlanFromItems,
  planPriceId,
  slotPriceId,
} from "../../services/billing/paddleCatalog.js";
import {
  billingCycle,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import type { Subscription, ValidatedPatchSlotsType } from "../../services/billing/types.js";
import {
  getSubscriptionForOrganization,
  upsertSubscription,
} from "../../services/billing/subscriptionServices.js";
import { getOrganizationForOwner } from "../../services/organization/organizationServices.js";

export type ActiveSubscription = Subscription & {
  paddleSubscriptionId: string;
  plan: subscriptionPlan;
  billingCycle: billingCycle;
};

/** 409s unless the caller's own org has an active Paddle subscription. */
export const requireOwnedActiveSubscription = async (
  userId: string
): Promise<{ organizationId: string; subscription: ActiveSubscription }> => {
  const organization = await getOrganizationForOwner(userId);
  const subscription = organization
    ? await getSubscriptionForOrganization(organization.id)
    : undefined;

  if (
    !organization ||
    !subscription?.paddleSubscriptionId ||
    !subscription.plan ||
    !subscription.billingCycle ||
    subscription.status !== subscriptionStatus.Active
  ) {
    throw new AppError({
      message: "No active subscription to modify",
      logging: true,
      code: 409,
      context: { userId },
    });
  }

  return { organizationId: organization.id, subscription: subscription as ActiveSubscription };
};

/**
 * Changes the extra-group-slot quantity on the existing Paddle subscription.
 * Slots are bought explicitly here, never implicitly on group creation — a
 * paid-for empty slot is harmless, a created-but-unpaid group is not.
 */
export const handlePatchSlots = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { paddle, paddleConfig } = requirePaddle();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPatchSlotsType = req.body;

  const { organizationId, subscription } = await requireOwnedActiveSubscription(auth.userId);

  const planKey = subscription.plan === subscriptionPlan.Enterprise ? "ENTERPRISE" : "PRO";
  const maxExtraSlots = PLAN_LIMITS[planKey].maxExtraSlots;
  if (data.extraGroupSlots > maxExtraSlots) {
    throw new AppError({
      message: `${planKey} allows at most ${maxExtraSlots.toString()} extra group slots`,
      logging: true,
      code: 422,
      publicContext: { limit: maxExtraSlots, requested: data.extraGroupSlots },
    });
  }

  if (data.extraGroupSlots === subscription.extraGroupSlots) {
    return res.status(200).json({ extraGroupSlots: subscription.extraGroupSlots, changed: false });
  }

  // All items on one Paddle subscription must share the billing period, so
  // the slot price always follows the plan's cycle.
  const items = [
    {
      priceId: planPriceId(paddleConfig.prices, subscription.plan, subscription.billingCycle),
      quantity: 1,
    },
    ...(data.extraGroupSlots > 0
      ? [
          {
            priceId: slotPriceId(paddleConfig.prices, subscription.billingCycle),
            quantity: data.extraGroupSlots,
          },
        ]
      : []),
  ];

  const updated = await paddle.subscriptions.update(subscription.paddleSubscriptionId, {
    items,
    prorationBillingMode:
      data.extraGroupSlots > subscription.extraGroupSlots
        ? "prorated_immediately"
        : "prorated_next_billing_period",
  });

  // The webhook remains the source of truth; this optimistic sync just keeps
  // the UI from lagging behind the change it triggered.
  const derived = derivePlanFromItems(
    paddleConfig.prices,
    updated.items.map((item) => ({ priceId: item.price?.id, quantity: item.quantity }))
  );
  if (derived) {
    await upsertSubscription(organizationId, derived);
  }

  return res.status(200).json({
    extraGroupSlots: derived?.extraGroupSlots ?? data.extraGroupSlots,
    changed: true,
  });
};
