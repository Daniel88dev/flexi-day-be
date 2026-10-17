import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import { paddedMonthRange } from "../../utils/dateFunc.js";
import { resolveEntitlements } from "../billing/entitlements.js";
import { getSubscriptionsForOrganizations } from "../billing/subscriptionServices.js";
import { getAllGroups, getGroup } from "../group/groupServices.js";
import type { GroupType } from "../group/types.js";
import { getAdministrableGroupIds, resolveGroupAccess } from "../groupUser/groupAccess.js";
import { getScopeEntries } from "../report/reportServices.js";
import {
  canCreateGroupEventIn,
  canEditGroupEvent,
  listGroupEventsInWindow,
  toGroupEventView,
} from "./groupEventServices.js";
import type { GroupEventGroup, GroupEventView } from "./types.js";

// The month grid shows at most 6 days of each neighbouring month, as `/api/vacation/calendar`.
const ADJACENT_DAYS = 6;

/**
 * Loads the group and the caller's standing in it, or throws: 404 for no such
 * live group, 403 without S2 rights.
 */
export const loadGroupForGroupEvents = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<{ group: GroupType; access: { isMember: boolean; canAdmin: boolean } }> => {
  const group = await getGroup(groupId, tx);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId },
    });
  }
  const access = await resolveGroupAccess(userId, group, tx);
  if (!canCreateGroupEventIn(access)) {
    throw new AppError({
      message: "No access to this group's events",
      logging: true,
      code: 403,
      context: { userId, groupId },
    });
  }
  return { group, access };
};

/**
 * `GET /api/group-events`: the padded month of one group's events, or of every
 * group the caller is a live member of. Never gated on the plan.
 */
export const listGroupEventsForMonth = async (
  userId: string,
  query: { year: number; month: number; groupId?: string }
): Promise<GroupEventView[]> => {
  const targets = query.groupId
    ? [await loadGroupForGroupEvents(userId, query.groupId)]
    : await Promise.all(
        (await getAllGroups((await getScopeEntries(userId)).map((entry) => entry.groupId))).map(
          async (group) => ({ group, access: await resolveGroupAccess(userId, group) })
        )
      );

  const byGroup = new Map(targets.map((target) => [target.group.id, target]));
  const rows = await listGroupEventsInWindow(
    [...byGroup.keys()],
    paddedMonthRange(query.year, query.month, ADJACENT_DAYS)
  );

  return rows.map(({ event, creator }) => {
    const target = byGroup.get(event.groupId)!;
    return toGroupEventView(event, {
      groupName: target.group.groupName,
      creator,
      canEdit: canEditGroupEvent(event, userId, target.access),
    });
  });
};

/**
 * `GET /api/group-events/groups`: every group the caller belongs to or
 * administers, with whether a create would pass S2 and S3 now.
 */
export const listGroupEventGroups = async (userId: string): Promise<GroupEventGroup[]> => {
  const memberGroupIds = (await getScopeEntries(userId)).map((entry) => entry.groupId);
  const administered = await getAdministrableGroupIds(userId);
  const groups = await getAllGroups([...new Set([...memberGroupIds, ...administered])]);

  const subscriptions = await getSubscriptionsForOrganizations([
    ...new Set(groups.map((group) => group.organizationId)),
  ]);
  const byOrganization = new Map(subscriptions.map((sub) => [sub.organizationId, sub]));
  const now = new Date();

  return Promise.all(
    groups.map(async (group) => {
      const access = await resolveGroupAccess(userId, group);
      const paid =
        resolveEntitlements(byOrganization.get(group.organizationId) ?? null, now).plan !== "FREE";
      return {
        groupId: group.id,
        groupName: group.groupName,
        canCreate: paid && canCreateGroupEventIn(access),
      };
    })
  );
};
