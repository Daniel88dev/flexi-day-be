import { and, count, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subscriptions } from "../../db/schema/subscription-schema.js";
import { supportAccess } from "../../db/schema/support-access-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { resolveEntitlements } from "../billing/entitlements.js";
import { getSubscriptionForOrganization } from "../billing/subscriptionServices.js";
import { listOrganizationAdmins } from "../organization/organizationServices.js";
import type {
  SupportGroupDetail,
  SupportOrganizationDetail,
  SupportOrganizationListItem,
} from "./types.js";

const SEARCH_LIMIT = 50;
const VACATION_LIMIT = 200;

/**
 * These reads exist only behind `requireSupportAdmin` and take their scope as
 * an explicit id instead of deriving it from the caller — support looks at
 * organizations the caller does not belong to. They must stay read-only; the
 * one write in this module is the audit row.
 */
export const recordSupportAccess = async (input: {
  userId: string;
  method: string;
  path: string;
}): Promise<void> => {
  await db.insert(supportAccess).values({
    id: generateRandomUUID(),
    userId: input.userId,
    method: input.method.slice(0, 8),
    path: input.path.slice(0, 2048),
  });
};

export const searchOrganizationsForSupport = async (
  query: string | undefined
): Promise<SupportOrganizationListItem[]> => {
  const trimmed = query?.trim();
  // `%`/`_` in the term would act as wildcards inside ILIKE — an admin
  // searching "a_b@x.com" must not match "axb@x.com".
  const pattern = trimmed ? `%${trimmed.replace(/([\\%_])/g, "\\$1")}%` : undefined;

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      ownerUserId: organizations.ownerUserId,
      ownerName: user.name,
      ownerEmail: user.email,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .innerJoin(user, eq(organizations.ownerUserId, user.id))
    .where(
      pattern
        ? or(
            ilike(organizations.name, pattern),
            ilike(user.email, pattern),
            ilike(user.name, pattern),
            eq(organizations.id, trimmed as string)
          )
        : undefined
    )
    .orderBy(desc(organizations.createdAt))
    .limit(SEARCH_LIMIT);

  if (rows.length === 0) return [];
  const organizationIds = rows.map((row) => row.id);

  const groupCounts = await db
    .select({ organizationId: groups.organizationId, liveGroups: count() })
    .from(groups)
    .where(and(inArray(groups.organizationId, organizationIds), isNull(groups.deletedAt)))
    .groupBy(groups.organizationId);

  // Full rows, not just the `plan` column: manual overrides (comped accounts,
  // Enterprise Custom) live in other columns and only `resolveEntitlements`
  // answers what the organization actually runs on.
  const subs = await db
    .select()
    .from(subscriptions)
    .where(inArray(subscriptions.organizationId, organizationIds));

  const countByOrg = new Map(groupCounts.map((row) => [row.organizationId, row.liveGroups]));
  const subByOrg = new Map(subs.map((row) => [row.organizationId, row]));
  const now = new Date();

  return rows.map((row) => {
    const sub = subByOrg.get(row.id);
    return {
      ...row,
      liveGroups: countByOrg.get(row.id) ?? 0,
      plan: resolveEntitlements(sub ?? null, now).plan,
      status: sub?.status ?? null,
    };
  });
};

export const getOrganizationDetailForSupport = async (
  organizationId: string
): Promise<SupportOrganizationDetail | undefined> => {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      billingEmail: organizations.billingEmail,
      paddleCustomerId: organizations.paddleCustomerId,
      createdAt: organizations.createdAt,
      ownerUserId: organizations.ownerUserId,
      ownerName: user.name,
      ownerEmail: user.email,
    })
    .from(organizations)
    .innerJoin(user, eq(organizations.ownerUserId, user.id))
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!row) return undefined;

  const subscription = await getSubscriptionForOrganization(organizationId);
  const entitlements = resolveEntitlements(subscription ?? null, new Date());

  // Deleted groups included on purpose — "my group disappeared" is exactly
  // the kind of report this surface exists to debug.
  const orgGroups = await db
    .select({
      id: groups.id,
      groupName: groups.groupName,
      managerUserId: groups.managerUserId,
      deletedAt: groups.deletedAt,
      createdAt: groups.createdAt,
    })
    .from(groups)
    .where(eq(groups.organizationId, organizationId))
    .orderBy(desc(groups.createdAt));

  const groupIds = orgGroups.map((group) => group.id);
  const memberCounts =
    groupIds.length === 0
      ? []
      : await db
          .select({ groupId: groupUsers.groupId, members: count() })
          .from(groupUsers)
          .where(and(inArray(groupUsers.groupId, groupIds), isNull(groupUsers.deletedAt)))
          .groupBy(groupUsers.groupId);
  const membersByGroup = new Map(memberCounts.map((row) => [row.groupId, row.members]));

  return {
    organization: {
      id: row.id,
      name: row.name,
      billingEmail: row.billingEmail,
      paddleCustomerId: row.paddleCustomerId,
      createdAt: row.createdAt,
    },
    owner: { userId: row.ownerUserId, name: row.ownerName, email: row.ownerEmail },
    plan: { ...entitlements, status: subscription?.status ?? null },
    groups: orgGroups.map((group) => ({
      ...group,
      members: membersByGroup.get(group.id) ?? 0,
    })),
    admins: await listOrganizationAdmins(organizationId),
  };
};

export const getGroupDetailForSupport = async (
  groupId: string
): Promise<SupportGroupDetail | undefined> => {
  const [row] = await db
    .select({
      id: groups.id,
      groupName: groups.groupName,
      organizationId: groups.organizationId,
      organizationName: organizations.name,
      managerUserId: groups.managerUserId,
      mainApprovalUser: groups.mainApprovalUser,
      tempApprovalUser: groups.tempApprovalUser,
      defaultVacationDays: groups.defaultVacationDays,
      defaultHomeOfficeDays: groups.defaultHomeOfficeDays,
      workingDays: groups.workingDays,
      holidayCountry: groups.holidayCountry,
      deletedAt: groups.deletedAt,
      createdAt: groups.createdAt,
    })
    .from(groups)
    .innerJoin(organizations, eq(groups.organizationId, organizations.id))
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!row) return undefined;

  // Removed members included, flagged by `deletedAt` — leaver bugs (quota
  // rows or mirrors surviving a removal) need the history visible.
  const members = await db
    .select({
      userId: groupUsers.userId,
      name: user.name,
      email: user.email,
      viewAccess: groupUsers.viewAccess,
      adminAccess: groupUsers.adminAccess,
      approverAccess: groupUsers.approverAccess,
      controlledUser: groupUsers.controlledUser,
      deletedAt: groupUsers.deletedAt,
    })
    .from(groupUsers)
    .innerJoin(user, eq(groupUsers.userId, user.id))
    .where(eq(groupUsers.groupId, groupId))
    .orderBy(user.name);

  const quotas = await db
    .select({
      userId: userYearQuotas.userId,
      relatedYear: userYearQuotas.relatedYear,
      vacationDays: userYearQuotas.vacationDays,
      homeOfficeDays: userYearQuotas.homeOfficeDays,
      sickDays: userYearQuotas.sickDays,
      carriedOverDays: userYearQuotas.carriedOverDays,
    })
    .from(userYearQuotas)
    .where(eq(userYearQuotas.groupId, groupId))
    .orderBy(desc(userYearQuotas.relatedYear));

  const vacations = await db
    .select({
      id: vacation.id,
      userId: vacation.userId,
      userName: user.name,
      requestedDay: vacation.requestedDay,
      vacationType: vacation.vacationType,
      halfDay: vacation.halfDay,
      approvedAt: vacation.approvedAt,
      approvedBy: vacation.approvedBy,
      rejectedAt: vacation.rejectedAt,
      deletedAt: vacation.deletedAt,
      createdAt: vacation.createdAt,
    })
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .where(eq(vacation.groupId, groupId))
    .orderBy(desc(vacation.requestedDay))
    .limit(VACATION_LIMIT);

  return { group: row, members, quotas, vacations };
};
