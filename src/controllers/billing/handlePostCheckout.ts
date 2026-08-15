import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { requirePaddle } from "../../utils/paddle.js";
import AppError from "../../utils/appError.js";
import { PLAN_LIMITS } from "../../services/billing/entitlements.js";
import { planPriceId, slotPriceId } from "../../services/billing/paddleCatalog.js";
import {
  billingCycle,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import type { ValidatedPostCheckoutType } from "../../services/billing/types.js";

const services = createDBServices();

/**
 * Statuses that still represent a subscription Paddle can bill or resume.
 * `paused` counts: buying a second one would leave the org owning two Paddle
 * subscriptions against a single local row, and a later `subscription.resumed`
 * for the old one would clobber the new.
 */
const ACTIVE_STATUSES = new Set<string>([
  subscriptionStatus.Active,
  subscriptionStatus.Trialing,
  subscriptionStatus.PastDue,
  subscriptionStatus.Paused,
]);

/**
 * Creates a Paddle transaction for the Paddle.js overlay to open. No price or
 * organization id ever originates client-side: the caller only names a plan,
 * and the org is always the caller's own.
 */
export const handlePostCheckout = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { paddle, paddleConfig } = requirePaddle();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostCheckoutType = req.body;

  const plan = data.plan === "ENTERPRISE" ? subscriptionPlan.Enterprise : subscriptionPlan.Pro;
  const cycle = data.billingCycle === "YEARLY" ? billingCycle.Yearly : billingCycle.Monthly;

  const maxExtraSlots = PLAN_LIMITS[data.plan].maxExtraSlots;
  if (data.extraGroupSlots > maxExtraSlots) {
    throw new AppError({
      message: `${data.plan} allows at most ${maxExtraSlots.toString()} extra group slots`,
      logging: true,
      code: 422,
      publicContext: { limit: maxExtraSlots, requested: data.extraGroupSlots },
    });
  }

  const organization = await services.organization.ensureOrganizationForUser(auth.userId);

  const existing = await services.billing.getSubscriptionForOrganization(organization.id);
  if (existing?.paddleSubscriptionId && existing.status && ACTIVE_STATUSES.has(existing.status)) {
    throw new AppError({
      message: "This organization already has a subscription — use change-plan instead",
      logging: true,
      code: 409,
      context: { organizationId: organization.id },
    });
  }

  const items = [
    { priceId: planPriceId(paddleConfig.prices, plan, cycle), quantity: 1 },
    ...(data.extraGroupSlots > 0
      ? [{ priceId: slotPriceId(paddleConfig.prices, cycle), quantity: data.extraGroupSlots }]
      : []),
  ];

  const transaction = await paddle.transactions.create({
    items,
    customData: { organizationId: organization.id },
    ...(organization.paddleCustomerId ? { customerId: organization.paddleCustomerId } : {}),
  });

  return res.status(201).json({ transactionId: transaction.id });
};
