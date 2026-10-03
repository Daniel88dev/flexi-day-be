import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAllGroups } from "../../services/group/groupServices.js";
import { toGroupListItems } from "../../services/group/groupListServices.js";
import { getAllGroupsForUser } from "../../services/groupUser/groupUserServices.js";

/**
 * The caller's own groups — the ones they book leave in. Deliberately
 * membership-only: this list also drives the dashboard, the calendar and the
 * request dialog, so groups the caller merely administers through their
 * organization must not appear here. Those are reached from
 * `/api/group/administered` and `/api/organization`.
 */
export const handleGetGroups = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const memberships = await getAllGroupsForUser(auth.userId);
  const membershipByGroup = new Map(memberships.map((m) => [m.groupId, m]));

  const result = await getAllGroups(memberships.map((m) => m.groupId));

  return res.status(200).json(await toGroupListItems(result, membershipByGroup));
};
