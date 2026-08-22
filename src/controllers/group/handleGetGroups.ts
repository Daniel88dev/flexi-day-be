import { createDBServices } from "../../services/DBServices.js";
import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { resolveOrganizationBadges } from "../../services/organization/organizationBadge.js";

const services = createDBServices();

/**
 * The caller's own groups — the ones they book leave in. Deliberately
 * membership-only: this list also drives the dashboard, the calendar and the
 * request dialog, so groups the caller merely administers through their
 * organization must not appear here. Those are reached from
 * `/api/organization`.
 */
export const handleGetGroups = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const memberships = await services.groupUser.getAllGroupsForUser(auth.userId);
  const membershipByGroup = new Map(memberships.map((m) => [m.groupId, m]));
  const groupIds = memberships.map((m) => m.groupId);

  const result = await services.group.getAllGroups(groupIds);

  const [badges, memberCounts] = await Promise.all([
    resolveOrganizationBadges(result.map((group) => group.organizationId)),
    services.groupUser.countMembersByGroup(groupIds),
  ]);

  return res.status(200).json(
    result.map((group) => {
      const membership = membershipByGroup.get(group.id);
      return {
        ...group,
        organization: badges.get(group.organizationId) ?? null,
        memberCount: memberCounts.get(group.id) ?? 0,
        membership: {
          adminAccess: membership?.adminAccess ?? false,
          approverAccess: membership?.approverAccess ?? false,
        },
      };
    })
  );
};
