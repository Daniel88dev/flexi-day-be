import AppError from "../../utils/appError.js";
import { getAllGroupsForUser } from "../groupUser/groupUserServices.js";
import { getAllGroups } from "../group/groupServices.js";
import { resolveOrganizationBadges } from "../organization/organizationBadge.js";

/** `publicContext.code` beside `reason: "PLAN_LIMIT"` when direct sync needs a paid plan. */
export const CALENDAR_SYNC_PLAN_REQUIRED = "CALENDAR_SYNC_PLAN_REQUIRED";

/**
 * Configs belong to users and plans to organizations: a user may sync while any
 * organization covering one of their groups is on a paid, writable plan.
 */
export const isCalendarSyncEntitled = async (userId: string): Promise<boolean> => {
  const memberships = await getAllGroupsForUser(userId);
  const groups = await getAllGroups(memberships.map((membership) => membership.groupId));
  const badges = await resolveOrganizationBadges(groups.map((group) => group.organizationId));
  return [...badges.values()].some((badge) => badge.active);
};

export const assertCalendarSyncEntitled = async (userId: string): Promise<void> => {
  if (await isCalendarSyncEntitled(userId)) return;
  throw new AppError({
    code: 402,
    message: "Direct calendar sync requires a paid plan",
    context: { userId },
    publicContext: { reason: "PLAN_LIMIT", code: CALENDAR_SYNC_PLAN_REQUIRED },
  });
};
