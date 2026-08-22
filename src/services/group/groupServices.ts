import type { GroupInsertType, GroupType } from "./types.js";
import { db, type DbTransaction } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { and, asc, count, eq, inArray, isNull, or } from "drizzle-orm";
import { user } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { alias } from "drizzle-orm/pg-core";

export const getGroup = async (
  groupId: string,
  tx?: DbTransaction
): Promise<GroupType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)));

  return row;
};

/**
 * `getGroup` under a row lock, for callers that recompute a column from the
 * value they just read — a plain read under READ COMMITTED lets a concurrent
 * writer commit in between and lose its change.
 */
export const lockGroup = async (
  groupId: string,
  tx: DbTransaction
): Promise<GroupType | undefined> => {
  const [row] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .for("update");

  return row;
};

export const getAllGroups = async (
  groupIds: string[],
  tx?: DbTransaction
): Promise<GroupType[]> => {
  if (groupIds.length === 0) return [];
  return (tx ?? db)
    .select()
    .from(groups)
    .where(and(inArray(groups.id, groupIds), isNull(groups.deletedAt)))
    .orderBy(asc(groups.groupName));
};

export const createGroup = async (
  data: GroupInsertType,
  tx?: DbTransaction
): Promise<GroupType | undefined> => {
  const [row] = await (tx ?? db).insert(groups).values(data).returning();
  return row;
};

export const updateGroupManager = async (
  groupId: string,
  newManagerId: string
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      managerUserId: newManagerId,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

export const updateGroupApprovalUsers = async (
  groupId: string,
  newMainApprovalUser: string | null,
  newTempApprovalUser: string | null,
  tx?: DbTransaction
): Promise<GroupType | undefined> => {
  const [row] = await (tx ?? db)
    .update(groups)
    .set({
      mainApprovalUser: newMainApprovalUser,
      tempApprovalUser: newTempApprovalUser,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

export const deleteGroup = async (groupId: string): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      deletedAt: new Date(),
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

export const updateGroupWorkingDays = async (
  groupId: string,
  newWorkingDays: number[]
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      workingDays: newWorkingDays,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

export const updateGroupHolidayCountry = async (
  groupId: string,
  holidayCountry: string | null
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      holidayCountry,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

export const updateGroupQuotas = async (
  groupId: string,
  newVacation: number,
  newHomeOffice: number
): Promise<GroupType | undefined> => {
  const [row] = await db
    .update(groups)
    .set({
      defaultVacationDays: newVacation,
      defaultHomeOfficeDays: newHomeOffice,
    })
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .returning();

  return row;
};

type GroupApprovalUsersType = {
  groupId: string;
  groupName: string;
  mainApprovalUserId: string | null;
  mainApprovalUserName: string | null;
  mainApprovalUserEmail: string | null;
  tempApprovalUserId: string | null;
  tempApprovalUserName: string | null;
  tempApprovalUserEmail: string | null;
};

/**
 * Returns the subset of supplied group ids on which the given user is an
 * authorized approver: the group's manager, its main or temp approver, or a
 * member whose membership carries `approverAccess`. Used by bulk
 * approve/reject to verify the caller can act on every distinct group in a
 * batch in a single query.
 */
export const getGroupsWhereUserCanApprove = async (
  groupIds: string[],
  approverUserId: string,
  tx?: DbTransaction
): Promise<string[]> => {
  if (groupIds.length === 0) return [];
  const rows = await (tx ?? db)
    .select({ id: groups.id })
    .from(groups)
    .leftJoin(
      groupUsers,
      and(
        eq(groupUsers.groupId, groups.id),
        eq(groupUsers.userId, approverUserId),
        isNull(groupUsers.deletedAt)
      )
    )
    .where(
      and(
        inArray(groups.id, groupIds),
        isNull(groups.deletedAt),
        or(
          eq(groups.managerUserId, approverUserId),
          eq(groups.mainApprovalUser, approverUserId),
          eq(groups.tempApprovalUser, approverUserId),
          eq(groupUsers.approverAccess, true)
        )
      )
    );
  return rows.map((r) => r.id);
};

export const getApprovalUsers = async (
  groupId: string,
  tx?: DbTransaction
): Promise<GroupApprovalUsersType | undefined> => {
  const mainApprovalUser = alias(user, "mainApprovalUser");
  const tempApprovalUser = alias(user, "tempApprovalUser");

  const [row] = await (tx ?? db)
    .select({
      groupId: groups.id,
      groupName: groups.groupName,
      mainApprovalUserId: mainApprovalUser.id,
      mainApprovalUserName: mainApprovalUser.name,
      mainApprovalUserEmail: mainApprovalUser.email,
      tempApprovalUserId: tempApprovalUser.id,
      tempApprovalUserName: tempApprovalUser.name,
      tempApprovalUserEmail: tempApprovalUser.email,
    })
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .leftJoin(mainApprovalUser, eq(groups.mainApprovalUser, mainApprovalUser.id))
    .leftJoin(tempApprovalUser, eq(groups.tempApprovalUser, tempApprovalUser.id));

  return row ?? undefined;
};

export const countLiveGroupsForOrganization = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ value: count() })
    .from(groups)
    .where(and(eq(groups.organizationId, organizationId), isNull(groups.deletedAt)));
  return Number(row?.value ?? 0);
};

/**
 * Live group ids of an organization, oldest first — the deterministic order
 * the billing guards use to decide which groups stay writable once a lapsed
 * plan's grace has expired: the oldest N keep working, the rest go read-only.
 */
export const getLiveGroupIdsForOrganizationOrdered = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<string[]> => {
  const rows = await (tx ?? db)
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.organizationId, organizationId), isNull(groups.deletedAt)))
    .orderBy(asc(groups.createdAt), asc(groups.id));
  return rows.map((row) => row.id);
};

/**
 * Narrows a set of group ids to the **live** groups of one organization.
 * Membership rows outlive a soft-deleted group, so without the `deletedAt`
 * filter a deleted group would still reach the administrable-group list that
 * mirroring uses as its source allowlist.
 */
export const filterGroupIdsByOrganization = async (
  groupIds: string[],
  organizationId: string,
  tx?: DbTransaction
): Promise<string[]> => {
  if (groupIds.length === 0) return [];
  const rows = await (tx ?? db)
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        inArray(groups.id, groupIds),
        eq(groups.organizationId, organizationId),
        isNull(groups.deletedAt)
      )
    );
  return rows.map((row) => row.id);
};

/** Live group ids across several organizations, for org-admin authorization. */
export const getLiveGroupIdsForOrganizations = async (
  organizationIds: string[],
  tx?: DbTransaction
): Promise<string[]> => {
  if (organizationIds.length === 0) return [];
  const rows = await (tx ?? db)
    .select({ id: groups.id })
    .from(groups)
    .where(and(inArray(groups.organizationId, organizationIds), isNull(groups.deletedAt)));
  return rows.map((row) => row.id);
};

/**
 * Live groups of an organization with their active member counts, oldest
 * first — the billing screen's usage meters.
 */
export const getGroupUsageForOrganization = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<{ id: string; groupName: string; members: number; createdAt: Date }[]> => {
  const rows = await (tx ?? db)
    .select({
      id: groups.id,
      groupName: groups.groupName,
      members: count(groupUsers.id),
      createdAt: groups.createdAt,
    })
    .from(groups)
    .leftJoin(groupUsers, and(eq(groupUsers.groupId, groups.id), isNull(groupUsers.deletedAt)))
    .where(and(eq(groups.organizationId, organizationId), isNull(groups.deletedAt)))
    .groupBy(groups.id)
    .orderBy(asc(groups.createdAt), asc(groups.id));

  return rows.map((row) => ({ ...row, members: Number(row.members) }));
};
