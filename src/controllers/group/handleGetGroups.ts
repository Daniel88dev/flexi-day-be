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

  const groups = (await services.groupUser.getAllGroupsForUser(auth.userId)).map(
    (group) => group.groupId
  );

  const result = await services.group.getAllGroups(groups);

  const badges = await resolveOrganizationBadges(result.map((group) => group.organizationId));

  return res
    .status(200)
    .json(
      result.map((group) => ({ ...group, organization: badges.get(group.organizationId) ?? null }))
    );
};
