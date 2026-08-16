import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { resolveEntitlements } from "../../services/billing/entitlements.js";
import { resolveAdministeredOrganization } from "./utils.js";

const services = createDBServices();

/**
 * The organization management screen: identity, the plan it runs on, its
 * groups and its administrators.
 *
 * Delegated admins see the plan but not the money — `billingEmail` and the
 * Paddle linkage stay owner-only, and subscription detail beyond plan/status
 * lives on `/api/billing/subscription`, which resolves by ownership.
 */
export const handleGetOrganization = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { organization, isOwner } = await resolveAdministeredOrganization(req);

  const subscription = await services.billing.getSubscriptionForOrganization(organization.id);
  const entitlements = resolveEntitlements(subscription ?? null, new Date());
  const groups = await services.group.getGroupUsageForOrganization(organization.id);
  const admins = await services.organization.listOrganizationAdmins(organization.id);

  return res.status(200).json({
    organization: {
      id: organization.id,
      name: organization.name,
      isOwner,
      billingEmail: isOwner ? organization.billingEmail : null,
      createdAt: organization.createdAt,
    },
    plan: {
      plan: entitlements.plan,
      status: subscription?.status ?? null,
      writable: entitlements.writable,
      graceEndsAt: entitlements.graceEndsAt,
      maxGroups: entitlements.maxGroups,
      maxMembersPerGroup: entitlements.maxMembersPerGroup,
    },
    groups: groups.map((group) => ({
      id: group.id,
      groupName: group.groupName,
      members: group.members,
      createdAt: group.createdAt,
    })),
    admins,
    viewer: { userId: auth.userId },
  });
};
