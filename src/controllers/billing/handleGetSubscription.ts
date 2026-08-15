import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { resolveEntitlements, PLAN_LIMITS } from "../../services/billing/entitlements.js";

const services = createDBServices();

/**
 * The caller's own organization only — the org is resolved from the session
 * user's ownership, never from a client-supplied id. Users who own no org yet
 * get Free entitlements and empty usage.
 */
export const handleGetSubscription = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const organization = await services.organization.getOrganizationForOwner(auth.userId);

  if (!organization) {
    return res.status(200).json({
      organization: null,
      subscription: null,
      entitlements: resolveEntitlements(null, new Date()),
      usage: { groupsUsed: 0, groups: [] },
      planLimits: PLAN_LIMITS,
    });
  }

  const subscription = await services.billing.getSubscriptionForOrganization(organization.id);
  const entitlements = resolveEntitlements(subscription ?? null, new Date());
  const groups = await services.group.getGroupUsageForOrganization(organization.id);

  return res.status(200).json({
    organization: {
      id: organization.id,
      name: organization.name,
      billingEmail: organization.billingEmail,
      hasPaddleCustomer: organization.paddleCustomerId !== null,
    },
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          billingCycle: subscription.billingCycle,
          extraGroupSlots: subscription.extraGroupSlots,
          currentPeriodEnd: subscription.currentPeriodEnd,
          graceEndsAt: subscription.graceEndsAt,
          cancelAt: subscription.cancelAt,
        }
      : null,
    entitlements,
    usage: {
      groupsUsed: groups.length,
      groups: groups.map((group) => ({
        id: group.id,
        groupName: group.groupName,
        members: group.members,
      })),
    },
    planLimits: PLAN_LIMITS,
  });
};
