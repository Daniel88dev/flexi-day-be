import type { GroupInsertType, GroupType } from "./types.js";
import { db, type DbTransaction } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { user } from "../../db/schema/auth-schema.js";
import { alias } from "drizzle-orm/pg-core";

export const getGroup = async (groupId: string): Promise<GroupType | undefined> => {
  const [row] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)));

  return row;
};

export const getAllGroups = async (groupIds: string[]): Promise<GroupType[]> => {
  return db
    .select()
    .from(groups)
    .where(and(inArray(groups.id, groupIds), isNull(groups.deletedAt)));
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
  newTempApprovalUser: string | null
): Promise<GroupType | undefined> => {
  const [row] = await db
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
 * authorized approver (manager, main, or temp approver). Used by bulk
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
    .where(
      and(
        inArray(groups.id, groupIds),
        isNull(groups.deletedAt),
        or(
          eq(groups.managerUserId, approverUserId),
          eq(groups.mainApprovalUser, approverUserId),
          eq(groups.tempApprovalUser, approverUserId)
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
