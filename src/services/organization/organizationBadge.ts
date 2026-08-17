import { resolveEntitlements, type PlanName } from "../billing/entitlements.js";
import { getSubscriptionsForOrganizations } from "../billing/subscriptionServices.js";
import { getOrganizationsByIds } from "./organizationServices.js";
import type { subscriptionStatus } from "../../db/schema/subscription-schema.js";

export type OrganizationBadge = {
  id: string;
  name: string;
  plan: PlanName | "CUSTOM";
  status: subscriptionStatus | null;
  /** False once a lapsed plan's grace has run out — the badge shows the plan as inactive. */
  active: boolean;
};

/**
 * The organization summary that rides along with a group, so a member can see
 * which organization covers their group and on what plan.
 *
 * It carries no billing internals: no billing email, no renewal date, no
 * amounts. Those stay on `/api/billing/subscription`, which resolves the
 * organization by ownership.
 */
export const resolveOrganizationBadges = async (
  organizationIds: string[]
): Promise<Map<string, OrganizationBadge>> => {
  const distinct = [...new Set(organizationIds)];
  if (distinct.length === 0) return new Map();

  const [organizations, subscriptions] = await Promise.all([
    getOrganizationsByIds(distinct),
    getSubscriptionsForOrganizations(distinct),
  ]);

  const subscriptionByOrg = new Map(
    subscriptions.map((subscription) => [subscription.organizationId, subscription])
  );
  const now = new Date();

  return new Map(
    organizations.map((organization) => {
      const subscription = subscriptionByOrg.get(organization.id) ?? null;
      const entitlements = resolveEntitlements(subscription, now);
      return [
        organization.id,
        {
          id: organization.id,
          name: organization.name,
          plan: entitlements.plan,
          status: subscription?.status ?? null,
          active: entitlements.plan !== "FREE" && entitlements.writable,
        },
      ];
    })
  );
};
