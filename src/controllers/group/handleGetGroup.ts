import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { resolveGroupAccess } from "../../services/groupUser/groupAccess.js";
import { resolveOrganizationBadges } from "../../services/organization/organizationBadge.js";

const services = createDBServices();

/**
 * One group with the caller's effective rights over it. Unlike `GET /api/group`
 * this reaches groups the caller only administers through the organization, so
 * an org admin can open a team's detail screen without being a member of it —
 * which is also why the group screens read their permissions from here rather
 * than inferring them from the member list.
 */
export const handleGetGroup = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  const group = await services.group.getGroup(groupId);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, groupId },
    });
  }

  // Reports exactly what the mutation endpoints will allow — the group screens
  // drive their controls off this, so an optimistic answer here would render
  // buttons that 403.
  const access = await resolveGroupAccess(auth.userId, group);

  if (!access.canView && !access.canAdmin) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
      context: { userId: auth.userId, groupId },
    });
  }

  const badges = await resolveOrganizationBadges([group.organizationId]);

  return res.status(200).json({
    ...group,
    organization: badges.get(group.organizationId) ?? null,
    access,
  });
};
