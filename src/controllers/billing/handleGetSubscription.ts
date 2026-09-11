import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { resolveEntitlements, PLAN_LIMITS } from "../../services/billing/entitlements.js";
import { getSubscriptionForOrganization } from "../../services/billing/subscriptionServices.js";
import { getGroupUsageForOrganization } from "../../services/group/groupServices.js";
import { getAdminOrganizationsForUser } from "../../services/organization/organizationServices.js";

/**
 * The organization the caller administers — owned first, else a delegate row.
 * Resolved from the session, never from a client-supplied id. Callers who
 * administer none get Free entitlements and empty usage.
 *
 * Unlike `resolveDefaultOrganization`, a delegate with several administered
 * organizations gets the oldest rather than a 400: the grace banner fires this
 * on every page, so it has to answer.
 */
export const handleGetSubscription = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const [organization] = await getAdminOrganizationsForUser(auth.userId);

  if (!organization) {
    return res.status(200).json({
      organization: null,
      subscription: null,
      entitlements: resolveEntitlements(null, new Date()),
      usage: { groupsUsed: 0, groups: [] },
      planLimits: PLAN_LIMITS,
    });
  }

  const subscription = await getSubscriptionForOrganization(organization.id);
  const entitlements = resolveEntitlements(subscription ?? null, new Date());
  const groups = await getGroupUsageForOrganization(organization.id);

  // The plan, never the money — the same split as `handleGetOrganization`.
  // `isOwner` gates the client's write affordances: checkout creates an
  // organization for the buyer, so a delegate offered "Subscribe" would
  // silently put a plan on one of their own.
  const isOwner = organization.ownerUserId === auth.userId;

  return res.status(200).json({
    organization: {
      id: organization.id,
      name: organization.name,
      isOwner,
      billingEmail: isOwner ? organization.billingEmail : null,
      hasPaddleCustomer: isOwner && organization.paddleCustomerId !== null,
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
