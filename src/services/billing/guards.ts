import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import { getSubscriptionForOrganization } from "./subscriptionServices.js";
import { resolveEntitlements, type Entitlements } from "./entitlements.js";
import {
  countLiveGroupsForOrganization,
  getAllGroups,
  getGroup,
  getLiveGroupIdsForOrganizationOrdered,
} from "../group/groupServices.js";
import { countActiveMembersInGroup } from "../groupUser/groupUserServices.js";
import { countOpenInvitesForGroup } from "../groupUser/inviteLinkServices.js";
import { getOrganizationById, lockOrganization } from "../organization/organizationServices.js";

const planLimitError = (params: {
  message: string;
  reason: "PLAN_LIMIT" | "READ_ONLY";
  limit: number;
  current: number;
  context?: { [key: string]: unknown };
}) =>
  new AppError({
    message: params.message,
    logging: true,
    code: 402,
    context: params.context,
    publicContext: { reason: params.reason, limit: params.limit, current: params.current },
  });

const entitlementsForOrganization = async (organizationId: string, tx?: DbTransaction) => {
  const sub = await getSubscriptionForOrganization(organizationId, tx);
  return resolveEntitlements(sub ?? null, new Date());
};

/**
 * Throws 402 when the organization already has as many live groups as its plan
 * allows. Callers inside a transaction get a row lock on the organization
 * first, which serialises concurrent creates — a bare `count(*)` under READ
 * COMMITTED lets parallel requests all read the same pre-insert count and all
 * succeed.
 */
export const assertCanCreateGroup = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<void> => {
  if (tx) await lockOrganization(organizationId, tx);

  const entitlements = await entitlementsForOrganization(organizationId, tx);
  const current = await countLiveGroupsForOrganization(organizationId, tx);
  if (current >= entitlements.maxGroups) {
    throw planLimitError({
      message: "Your plan's group limit has been reached",
      reason: "PLAN_LIMIT",
      limit: entitlements.maxGroups,
      current,
      context: { organizationId },
    });
  }
};

/**
 * Throws 402 when the group is at its per-group headcount cap. Open invites
 * count against the cap: the invite endpoint is only a UX gate, but the
 * redemption transaction calls this too, and pending codes must reserve their
 * seat or parallel redemptions overfill the group.
 */
export const assertCanAddMember = async (
  groupId: string,
  tx?: DbTransaction,
  options?: {
    /**
     * Set by the redemption path: the invite being redeemed is still open
     * inside its transaction, and its reserved seat is the one being consumed
     * — counting it too would block redeeming the last seat.
     */
    redeemingOpenInvite?: boolean;
  }
): Promise<void> => {
  const group = await getGroup(groupId, tx);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId },
    });
  }

  // Same reasoning as assertCanCreateGroup: `count(*)` under READ COMMITTED
  // gives two concurrent inviters the same pre-insert total, so both would
  // pass and the group would end up with more outstanding seats than the plan
  // allows. Serialising on the organization row is what actually prevents it.
  if (tx) await lockOrganization(group.organizationId, tx);

  const entitlements = await entitlementsForOrganization(group.organizationId, tx);
  const members = await countActiveMembersInGroup(groupId, tx);
  const allOpenInvites = await countOpenInvitesForGroup(groupId, tx);
  const openInvites = options?.redeemingOpenInvite
    ? Math.max(0, allOpenInvites - 1)
    : allOpenInvites;
  const current = members + openInvites;
  if (current >= entitlements.maxMembersPerGroup) {
    throw planLimitError({
      message: "This group is at its member limit",
      reason: "PLAN_LIMIT",
      limit: entitlements.maxMembersPerGroup,
      current,
      context: { groupId, members, openInvites },
    });
  }
};

/**
 * Throws 402 once grace has expired and this group is over the plan's limits.
 * Over-limit groups are chosen deterministically: the oldest N by `createdAt`
 * stay writable, the rest go read-only. A group whose headcount exceeds the
 * per-group cap is read-only regardless of its age. Nothing is deleted or
 * hidden — the group stays viewable.
 */
export const assertGroupWritable = async (groupId: string, tx?: DbTransaction): Promise<void> => {
  const group = await getGroup(groupId, tx);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId },
    });
  }

  const entitlements = await entitlementsForOrganization(group.organizationId, tx);
  if (entitlements.writable) return;

  const orderedIds = await getLiveGroupIdsForOrganizationOrdered(group.organizationId, tx);
  const writableIds = new Set(orderedIds.slice(0, entitlements.maxGroups));
  if (!writableIds.has(groupId)) {
    throw planLimitError({
      message: "This group is read-only on your current plan",
      reason: "READ_ONLY",
      limit: entitlements.maxGroups,
      current: orderedIds.length,
      context: { groupId, organizationId: group.organizationId },
    });
  }

  const members = await countActiveMembersInGroup(groupId, tx);
  if (members > entitlements.maxMembersPerGroup) {
    throw planLimitError({
      message: "This group is read-only on your current plan",
      reason: "READ_ONLY",
      limit: entitlements.maxMembersPerGroup,
      current: members,
      context: { groupId, organizationId: group.organizationId },
    });
  }
};

/**
 * Throws 402 unless the organization is on a paid plan right now (grace still
 * counts as paid). Guards switching the Sick day benefit on; switching it off
 * is always allowed.
 */
export const assertCanEnableSickDayBenefit = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<void> => {
  const entitlements = await entitlementsForOrganization(organizationId, tx);
  if (entitlements.plan === "FREE") {
    throw new AppError({
      message: "The Sick day benefit requires a paid plan",
      logging: true,
      code: 402,
      context: { organizationId },
      publicContext: { reason: "PLAN_LIMIT" },
    });
  }
};

/**
 * The benefit is active only while the stored toggle is on AND the plan is
 * paid. Derived at read time like every entitlement: a lapse makes this false
 * without touching the toggle or any data, and re-subscribing makes it true
 * again — that is the whole dormancy mechanism.
 */
export const isSickDayBenefitActive = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const organization = await getOrganizationById(organizationId, tx);
  if (!organization?.sickDayBenefitEnabled) return false;

  const entitlements = await entitlementsForOrganization(organizationId, tx);
  return entitlements.plan !== "FREE";
};

/** Throws 422 when the group's organization does not have an active Sick day benefit. */
export const assertSickDayRequestable = async (
  groupId: string,
  tx?: DbTransaction
): Promise<void> => {
  const group = await getGroup(groupId, tx);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId },
    });
  }

  if (!(await isSickDayBenefitActive(group.organizationId, tx))) {
    throw new AppError({
      message: "The Sick day benefit is not enabled for this organization",
      logging: true,
      code: 422,
      context: { groupId, organizationId: group.organizationId },
      publicContext: { reason: "SICK_DAY_BENEFIT_DISABLED" },
    });
  }
};

/**
 * Bulk variant. Resolves each organization's entitlements once instead of per
 * group: a 50-request approval spanning 10 groups runs inside an open
 * transaction holding row locks, so the round-trips are not free.
 */
export const assertGroupsWritable = async (
  groupIds: string[],
  tx?: DbTransaction
): Promise<void> => {
  const distinct = [...new Set(groupIds)];
  if (distinct.length === 0) return;

  const groups = await getAllGroups(distinct, tx);
  const missing = distinct.find((id) => !groups.some((group) => group.id === id));
  if (missing) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId: missing },
    });
  }

  const entitlementsByOrg = new Map<string, Entitlements>();
  for (const organizationId of new Set(groups.map((group) => group.organizationId))) {
    entitlementsByOrg.set(organizationId, await entitlementsForOrganization(organizationId, tx));
  }

  // Only organizations that have actually lapsed need the ordering query.
  const orderedByOrg = new Map<string, string[]>();
  for (const [organizationId, entitlements] of entitlementsByOrg) {
    if (!entitlements.writable) {
      orderedByOrg.set(
        organizationId,
        await getLiveGroupIdsForOrganizationOrdered(organizationId, tx)
      );
    }
  }

  for (const group of groups) {
    const entitlements = entitlementsByOrg.get(group.organizationId)!;
    if (entitlements.writable) continue;

    const orderedIds = orderedByOrg.get(group.organizationId)!;
    if (!new Set(orderedIds.slice(0, entitlements.maxGroups)).has(group.id)) {
      throw planLimitError({
        message: "This group is read-only on your current plan",
        reason: "READ_ONLY",
        limit: entitlements.maxGroups,
        current: orderedIds.length,
        context: { groupId: group.id, organizationId: group.organizationId },
      });
    }

    const members = await countActiveMembersInGroup(group.id, tx);
    if (members > entitlements.maxMembersPerGroup) {
      throw planLimitError({
        message: "This group is read-only on your current plan",
        reason: "READ_ONLY",
        limit: entitlements.maxMembersPerGroup,
        current: members,
        context: { groupId: group.id, organizationId: group.organizationId },
      });
    }
  }
};
