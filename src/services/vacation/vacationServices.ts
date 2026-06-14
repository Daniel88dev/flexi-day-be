import { db, type DbTransaction } from "../../db/db.js";
import { vacation, vacationType } from "../../db/schema/vacation-schema.js";
import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  VacationInsertType,
  VacationListItem,
  VacationType,
} from "./types.js";
import { user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import {
  buildUserSummary,
  type UserSummary,
} from "../../utils/userPresentation.js";

type VacationRowWithUser = VacationType & {
  userName: string;
};

const toListItem = (row: VacationRowWithUser): VacationListItem => {
  const { userName, ...rest } = row;
  const userSummary: UserSummary = buildUserSummary({
    id: row.userId,
    name: userName,
  });
  return { ...rest, user: userSummary };
};

const baseVacationSelection = {
  id: vacation.id,
  userId: vacation.userId,
  groupId: vacation.groupId,
  requestedDay: vacation.requestedDay,
  startTime: vacation.startTime,
  endTime: vacation.endTime,
  vacationType: vacation.vacationType,
  approvedAt: vacation.approvedAt,
  approvedBy: vacation.approvedBy,
  deletedAt: vacation.deletedAt,
  rejectedAt: vacation.rejectedAt,
  rejectedBy: vacation.rejectedBy,
  rejectionReason: vacation.rejectionReason,
  note: vacation.note,
  createdAt: vacation.createdAt,
  updatedAt: vacation.updatedAt,
  userName: user.name,
};

/**
 * Retrieves a list of vacations for a specific group within a given date range,
 * enriched with the requesting user's display summary. Optionally filters by user.
 */
export const getVacationsForGroup = async (
  groupId: string,
  startDate: string,
  endDate: string,
  userId: string | null = null
): Promise<VacationListItem[]> => {
  const base = [
    eq(vacation.groupId, groupId),
    isNull(vacation.deletedAt),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate),
  ] as const;
  const where =
    userId !== null ? and(...base, eq(vacation.userId, userId)) : and(...base);

  const rows = await db
    .select(baseVacationSelection)
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .where(where)
    .orderBy(asc(vacation.requestedDay));

  return rows.map(toListItem);
};

/**
 * Retrieves a list of vacations for a specific user within a specified date range,
 * enriched with the user's display summary.
 */
export const getVacationsForUser = async (
  userId: string,
  startDate: string,
  endDate: string
): Promise<VacationListItem[]> => {
  const where = and(
    eq(vacation.userId, userId),
    isNull(vacation.deletedAt),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate)
  );

  const rows = await db
    .select(baseVacationSelection)
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .where(where)
    .orderBy(asc(vacation.requestedDay));

  return rows.map(toListItem);
};

/**
 * Inserts a single vacation row. Returns undefined on unique-constraint
 * collisions so callers can decide how to handle them.
 */
export const postVacation = async (
  record: VacationInsertType,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .insert(vacation)
    .values(record)
    .onConflictDoNothing({
      target: [vacation.userId, vacation.requestedDay],
    })
    .returning();
  return row;
};

/**
 * Inserts many per-day vacation rows in a single statement. Conflicts on
 * (userId, requestedDay) are skipped.
 */
export const postVacationBulk = async (
  records: VacationInsertType[],
  tx?: DbTransaction
): Promise<VacationType[]> => {
  if (records.length === 0) return [];
  return (tx ?? db)
    .insert(vacation)
    .values(records)
    .onConflictDoNothing({
      target: [vacation.userId, vacation.requestedDay],
    })
    .returning();
};

export const approveVacation = async (
  vacationId: string,
  approvingPerson: string,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(vacation)
    .set({
      approvedBy: approvingPerson,
      approvedAt: new Date(),
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};

export const rejectVacation = async (
  vacationId: string,
  rejectingPerson: string,
  reason: string | null = null,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(vacation)
    .set({
      rejectedAt: new Date(),
      rejectedBy: rejectingPerson,
      rejectionReason: reason,
      approvedAt: null,
      approvedBy: null,
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};

export const deleteVacation = async (
  vacationId: string,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(vacation)
    .set({
      deletedAt: new Date(),
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};

export const getVacationById = async (
  vacationId: string,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(vacation)
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)));

  return row;
};

export type PendingApprovalRow = {
  vacationId: string;
  userId: string;
  userName: string;
  groupId: string;
  groupName: string;
  vacationType: vacationType;
  requestedDay: string;
  note: string | null;
  submittedAt: Date;
};

/**
 * Returns pending (not yet approved, not rejected, not deleted) vacation rows
 * for groups where the caller is a manager / main approver / temp approver.
 * Rows are ordered by user/group/day so the caller can collapse contiguous
 * ranges into single approval entries.
 */
export const getPendingApprovalsForApprover = async (
  approverUserId: string
): Promise<PendingApprovalRow[]> => {
  return db
    .select({
      vacationId: vacation.id,
      userId: vacation.userId,
      userName: user.name,
      groupId: vacation.groupId,
      groupName: groups.groupName,
      vacationType: vacation.vacationType,
      requestedDay: vacation.requestedDay,
      note: vacation.note,
      submittedAt: vacation.createdAt,
    })
    .from(vacation)
    .innerJoin(groups, eq(vacation.groupId, groups.id))
    .innerJoin(user, eq(vacation.userId, user.id))
    .where(
      and(
        isNull(vacation.deletedAt),
        isNull(vacation.approvedAt),
        isNull(vacation.rejectedAt),
        isNull(groups.deletedAt),
        or(
          eq(groups.managerUserId, approverUserId),
          eq(groups.mainApprovalUser, approverUserId),
          eq(groups.tempApprovalUser, approverUserId)
        )
      )
    )
    .orderBy(
      asc(vacation.userId),
      asc(vacation.groupId),
      asc(vacation.requestedDay)
    );
};

/**
 * Counts pending approval rows (raw row count) the caller can act on.
 */
export const countPendingApprovalsForApprover = async (
  approverUserId: string
): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(vacation)
    .innerJoin(groups, eq(vacation.groupId, groups.id))
    .where(
      and(
        isNull(vacation.deletedAt),
        isNull(vacation.approvedAt),
        isNull(vacation.rejectedAt),
        isNull(groups.deletedAt),
        or(
          eq(groups.managerUserId, approverUserId),
          eq(groups.mainApprovalUser, approverUserId),
          eq(groups.tempApprovalUser, approverUserId)
        )
      )
    );
  return Number(row?.value ?? 0);
};

/**
 * Counts the distinct users with an approved vacation overlapping `today` in
 * any of the supplied group ids.
 */
export const countUsersOutOnDay = async (
  groupIds: string[],
  isoDate: string
): Promise<number> => {
  if (groupIds.length === 0) return 0;
  const [row] = await db
    .select({ value: countDistinct(vacation.userId) })
    .from(vacation)
    .where(
      and(
        inArray(vacation.groupId, groupIds),
        isNull(vacation.deletedAt),
        isNotNull(vacation.approvedAt),
        eq(vacation.requestedDay, isoDate)
      )
    );
  return Number(row?.value ?? 0);
};

/**
 * Counts approved vacations (excluding bank holidays) overlapping the given
 * inclusive range across the supplied groups. Used to estimate upcoming load.
 */
export const countApprovedVacationsInRange = async (
  groupIds: string[],
  fromIsoInclusive: string,
  toIsoInclusive: string
): Promise<number> => {
  if (groupIds.length === 0) return 0;
  const [row] = await db
    .select({ value: count() })
    .from(vacation)
    .where(
      and(
        inArray(vacation.groupId, groupIds),
        isNull(vacation.deletedAt),
        isNotNull(vacation.approvedAt),
        gte(vacation.requestedDay, fromIsoInclusive),
        lte(vacation.requestedDay, toIsoInclusive)
      )
    );
  return Number(row?.value ?? 0);
};

/**
 * Aggregates user vacation usage per vacation type for the supplied groups
 * and year. Approved (or non-rejected) usage is split into "used" and
 * "pending" buckets matching the `BalanceWidget` shape.
 */
export const aggregateUserUsageForYear = async (
  userId: string,
  groupIds: string[],
  year: number
): Promise<{ type: vacationType; used: number; pending: number }[]> => {
  if (groupIds.length === 0) return [];
  const yearStart = `${year.toString().padStart(4, "0")}-01-01`;
  const yearEnd = `${(year + 1).toString().padStart(4, "0")}-01-01`;

  const rows = await db
    .select({
      type: vacation.vacationType,
      used: sql<number>`COUNT(*) FILTER (WHERE ${vacation.approvedAt} IS NOT NULL)`,
      pending: sql<number>`COUNT(*) FILTER (WHERE ${vacation.approvedAt} IS NULL AND ${vacation.rejectedAt} IS NULL)`,
    })
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, userId),
        inArray(vacation.groupId, groupIds),
        isNull(vacation.deletedAt),
        gte(vacation.requestedDay, yearStart),
        lt(vacation.requestedDay, yearEnd)
      )
    )
    .groupBy(vacation.vacationType);

  return rows.map((r) => ({
    type: r.type,
    used: Number(r.used),
    pending: Number(r.pending),
  }));
};
