import AppError from "../../utils/appError.js";
import { db, type DbTransaction } from "../../db/db.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type {
  GroupVacationListItem,
  LiveVacationType,
  VacationDetail,
  VacationInsertType,
  VacationListItem,
  VacationType,
} from "./types.js";
import { user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { alias } from "drizzle-orm/pg-core";
import { buildUserSummary, type UserSummary } from "../../utils/userPresentation.js";
import { sumDaysWhere } from "./dayWeight.js";

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
  halfDay: vacation.halfDay,
  approvedAt: vacation.approvedAt,
  approvedBy: vacation.approvedBy,
  deletedAt: vacation.deletedAt,
  deletedByUserId: vacation.deletedByUserId,
  rejectedAt: vacation.rejectedAt,
  rejectedBy: vacation.rejectedBy,
  rejectionReason: vacation.rejectionReason,
  note: vacation.note,
  createdByUserId: vacation.createdByUserId,
  createdAt: vacation.createdAt,
  updatedAt: vacation.updatedAt,
  userName: user.name,
};

/**
 * Retrieves a list of vacations for a specific group within a given date range,
 * enriched with the requesting user's display summary. Optionally filters by user.
 *
 * Also returns records a member has mirrored into this group from another one
 * they belong to (see `group_mirrors`). Those carry a non-null
 * `mirroredFromGroupId` and stay owned by their source group: they are only
 * projected here for visibility, are never approvable in this group — the
 * approval queries key on `vacation.groupId` — and never count against this
 * group's quotas or reports.
 */
export const getVacationsForGroup = async (
  groupId: string,
  startDate: string,
  endDate: string,
  userId: string | null = null,
  options?: { includeCancelled?: boolean }
): Promise<GroupVacationListItem[]> => {
  // A mirror only projects records of someone who still belongs to the target
  // group; without this a member who left would keep leaking time off into it.
  const stillAMember = exists(
    db
      .select({ one: sql`1` })
      .from(groupUsers)
      .where(
        and(
          eq(groupUsers.userId, vacation.userId),
          eq(groupUsers.groupId, groupId),
          isNull(groupUsers.deletedAt)
        )
      )
  );

  const inThisGroup = eq(vacation.groupId, groupId);
  const mirroredIntoThisGroup = and(isNotNull(groupMirrors.id), stillAMember);

  const base = [
    options?.includeCancelled ? undefined : isNull(vacation.deletedAt),
    gte(vacation.requestedDay, startDate),
    lt(vacation.requestedDay, endDate),
    or(inThisGroup, mirroredIntoThisGroup),
  ] as const;
  const where = userId !== null ? and(...base, eq(vacation.userId, userId)) : and(...base);

  const rows = await db
    .select({ ...baseVacationSelection, sourceGroupName: groups.groupName })
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .innerJoin(groups, eq(vacation.groupId, groups.id))
    // At most one row can match: `group_mirrors_user_source_target_uniq` makes
    // (user, source, target) unique among active mirrors, so this cannot fan out.
    .leftJoin(
      groupMirrors,
      and(
        eq(groupMirrors.userId, vacation.userId),
        eq(groupMirrors.sourceGroupId, vacation.groupId),
        eq(groupMirrors.targetGroupId, groupId),
        isNull(groupMirrors.deletedAt)
      )
    )
    .where(where)
    .orderBy(asc(vacation.requestedDay));

  return rows.map(({ sourceGroupName, ...row }) => {
    const mirrored = row.groupId !== groupId;
    return {
      ...toListItem(row),
      mirroredFromGroupId: mirrored ? row.groupId : null,
      mirroredFromGroupName: mirrored ? sourceGroupName : null,
    };
  });
};

/**
 * Retrieves a list of vacations for a specific user within a specified date range,
 * enriched with the user's display summary.
 */
export const getVacationsForUser = async (
  userId: string,
  startDate: string,
  endDate: string,
  options?: { includeCancelled?: boolean }
): Promise<VacationListItem[]> => {
  const where = and(
    eq(vacation.userId, userId),
    options?.includeCancelled ? undefined : isNull(vacation.deletedAt),
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
 * Predicate of the partial `uniq_vacation_user_day` index. Only live rows
 * reserve a day, so a cancelled or rejected one can be booked again — but
 * Postgres can only infer a partial index when ON CONFLICT repeats its
 * predicate, hence this fragment on every insert against it. Drizzle emits it
 * from `onConflictDoNothing`'s `where`, which lands in the index-predicate
 * position, not as an action filter.
 */
const liveRowConflictTarget = sql`${vacation.deletedAt} IS NULL AND ${vacation.rejectedAt} IS NULL`;

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
      where: liveRowConflictTarget,
    })
    .returning();
  return row;
};

/**
 * Inserts many per-day vacation rows in a single statement. All-or-nothing:
 * if any (userId, requestedDay) is already held by a live row, throws — and
 * because the caller wraps this in `db.transaction`, the partial inserts are
 * rolled back. That avoids the silent partial-commit case where a multi-day
 * request that overlaps one existing day would otherwise persist the remaining
 * days and still look like a success. Days whose only rows are cancelled or
 * rejected are free (see {@link liveRowConflictTarget}).
 */
export const postVacationBulk = async (
  records: VacationInsertType[],
  tx?: DbTransaction
): Promise<VacationType[]> => {
  if (records.length === 0) return [];
  const inserted = await (tx ?? db)
    .insert(vacation)
    .values(records)
    .onConflictDoNothing({
      target: [vacation.userId, vacation.requestedDay],
      where: liveRowConflictTarget,
    })
    .returning();

  if (inserted.length !== records.length) {
    const insertedDays = new Set(inserted.map((r) => r.requestedDay));
    const conflictingDays = records.map((r) => r.requestedDay).filter((d) => !insertedDays.has(d));
    throw new AppError({
      code: 409,
      message: "One or more days in the requested range are already booked",
      logging: true,
      context: {
        conflictingDays,
        requested: records.length,
        inserted: inserted.length,
      },
      publicContext: { conflictingDays },
    });
  }

  return inserted;
};

/**
 * The workflow's state machine. Cancellation deliberately does NOT use it:
 * plans change, and an approved request must stay cancellable.
 */
const stillPending = [
  isNull(vacation.deletedAt),
  isNull(vacation.approvedAt),
  isNull(vacation.rejectedAt),
] as const;

/** Unreachable while decisions are pending-only; kept so widening the predicate 409s, not 500s. */
const rethrowIfDayRetaken = (error: unknown, vacationIds: string[]): never => {
  // Drizzle rethrows a "Failed query" Error and hangs the pg error, which is
  // where `code`/`constraint` live, off `cause`.
  let cursor: unknown = error;
  let violated = false;
  for (let depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === "uniq_vacation_user_day") {
      violated = true;
      break;
    }
    cursor = candidate.cause;
  }

  if (violated) {
    throw new AppError({
      code: 409,
      message:
        "That day was requested again after the rejection — refresh and decide on the new request",
      logging: true,
      context: { vacationIds },
    });
  }
  throw error;
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
    })
    .where(and(eq(vacation.id, vacationId), ...stillPending))
    .returning()
    .catch((error: unknown) => rethrowIfDayRetaken(error, [vacationId]));

  return row;
};

/**
 * Bulk-approves in one statement. Returns only the rows actually updated;
 * callers compare against the input ids and reject the whole batch on a short
 * result.
 */
export const approveVacationsBulk = async (
  vacationIds: string[],
  approvingPerson: string,
  tx?: DbTransaction
): Promise<VacationType[]> => {
  if (vacationIds.length === 0) return [];
  return (tx ?? db)
    .update(vacation)
    .set({
      approvedBy: approvingPerson,
      approvedAt: new Date(),
    })
    .where(and(inArray(vacation.id, vacationIds), ...stillPending))
    .returning()
    .catch((error: unknown) => rethrowIfDayRetaken(error, vacationIds));
};

/**
 * Bulk-rejects many vacation rows in a single statement. See approveVacationsBulk.
 */
export const rejectVacationsBulk = async (
  vacationIds: string[],
  rejectingPerson: string,
  reason: string | null = null,
  tx?: DbTransaction
): Promise<VacationType[]> => {
  if (vacationIds.length === 0) return [];
  return (tx ?? db)
    .update(vacation)
    .set({
      rejectedAt: new Date(),
      rejectedBy: rejectingPerson,
      rejectionReason: reason,
    })
    .where(and(inArray(vacation.id, vacationIds), ...stillPending))
    .returning();
};

/** Bulk-cancels (soft-deletes) many vacation rows in a single statement. See rejectVacationsBulk. */
export const cancelVacationsBulk = async (
  vacationIds: string[],
  cancellingPerson: string,
  tx?: DbTransaction
): Promise<VacationType[]> => {
  if (vacationIds.length === 0) return [];
  return (tx ?? db)
    .update(vacation)
    .set({
      deletedAt: new Date(),
      deletedByUserId: cancellingPerson,
    })
    .where(and(inArray(vacation.id, vacationIds), isNull(vacation.deletedAt)))
    .returning();
};

/**
 * Fetches vacation rows by id (active rows only). Used during bulk approve /
 * reject to authorize the caller against every distinct group in the batch.
 * `forUpdate` locks the rows for the transaction — the edit path needs it so a
 * concurrent PATCH serializes behind this read instead of overwriting it with
 * values (and an UPDATED-event summary) computed from a stale snapshot.
 */
export const getVacationsByIds = async (
  vacationIds: string[],
  tx?: DbTransaction,
  options?: { forUpdate?: boolean }
): Promise<LiveVacationType[]> => {
  if (vacationIds.length === 0) return [];
  const query = (tx ?? db)
    .select()
    .from(vacation)
    .where(and(inArray(vacation.id, vacationIds), isNull(vacation.deletedAt)));
  const rows = await (options?.forUpdate ? query.for("update") : query);
  // Live by the `isNull` above; nothing checks the narrowing at runtime.
  return rows as LiveVacationType[];
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
    })
    .where(and(eq(vacation.id, vacationId), ...stillPending))
    .returning();

  return row;
};

export const deleteVacation = async (
  vacationId: string,
  cancellingPerson: string,
  tx?: DbTransaction
): Promise<VacationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(vacation)
    .set({
      deletedAt: new Date(),
      deletedByUserId: cancellingPerson,
    })
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)))
    .returning();

  return row;
};

/** Per-day fields an admin may edit in place; day moves are cancel + re-create. */
export type VacationUpdatePatch = Partial<
  Pick<VacationType, "startTime" | "endTime" | "vacationType" | "halfDay" | "note">
>;

/**
 * Applies one patch to many day rows in a single statement. Live rows only —
 * the WHERE repeats the not-deleted/not-rejected predicate so a concurrent
 * cancel or reject drops the row from RETURNING and the caller can 409 instead
 * of silently resurrecting it. `deletedAt`/`rejectedAt` are never touched here,
 * which keeps the partial `uniq_vacation_user_day` index out of play.
 */
export const updateVacationRows = async (
  vacationIds: string[],
  patch: VacationUpdatePatch,
  tx?: DbTransaction
): Promise<VacationType[]> => {
  if (vacationIds.length === 0) return [];
  return (tx ?? db)
    .update(vacation)
    .set(patch)
    .where(
      and(
        inArray(vacation.id, vacationIds),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt)
      )
    )
    .returning();
};

// Given all sibling rows, returns the consecutive-day run containing `targetDay` ([] if absent).
export const contiguousRunContaining = <T extends { requestedDay: string }>(
  rows: T[],
  targetDay: string
): T[] => {
  const sorted = [...rows].sort((a, b) =>
    a.requestedDay < b.requestedDay ? -1 : a.requestedDay > b.requestedDay ? 1 : 0
  );
  const targetIdx = sorted.findIndex((r) => r.requestedDay === targetDay);
  if (targetIdx === -1) return [];

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const dayMs = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();
  const adjacent = (earlier: T | undefined, later: T | undefined): boolean =>
    earlier !== undefined &&
    later !== undefined &&
    dayMs(later.requestedDay) - dayMs(earlier.requestedDay) === ONE_DAY_MS;

  let start = targetIdx;
  while (start > 0 && adjacent(sorted.at(start - 1), sorted.at(start))) start--;
  let end = targetIdx;
  while (end < sorted.length - 1 && adjacent(sorted.at(end), sorted.at(end + 1))) end++;

  return sorted.slice(start, end + 1);
};

/**
 * Loads a single vacation with everything the detail view shows: the
 * requester, the group name, and the decision makers. Unlike
 * {@link getVacationById} this deliberately includes cancelled (soft-deleted)
 * rows — the whole point of the detail view is to explain what happened to a
 * request, which includes its cancellation. Also resolves the contiguous
 * same-type run this row belongs to (`rangeStart` / `rangeEnd` / `vacationIds`).
 */
export const getVacationDetailById = async (
  vacationId: string,
  tx?: DbTransaction
): Promise<VacationDetail | undefined> => {
  const approver = alias(user, "approvedByUser");
  const rejecter = alias(user, "rejectedByUser");
  const creator = alias(user, "createdByUser");
  const canceller = alias(user, "deletedByUser");

  const [row] = await (tx ?? db)
    .select({
      ...baseVacationSelection,
      groupName: groups.groupName,
      approvedByName: approver.name,
      rejectedByName: rejecter.name,
      createdByName: creator.name,
      deletedByName: canceller.name,
    })
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .innerJoin(groups, eq(vacation.groupId, groups.id))
    .leftJoin(approver, eq(vacation.approvedBy, approver.id))
    .leftJoin(rejecter, eq(vacation.rejectedBy, rejecter.id))
    .leftJoin(creator, eq(vacation.createdByUserId, creator.id))
    .leftJoin(canceller, eq(vacation.deletedByUserId, canceller.id))
    .where(eq(vacation.id, vacationId))
    .limit(1);

  if (!row) return undefined;

  const {
    groupName,
    approvedByName,
    rejectedByName,
    createdByName,
    deletedByName,
    ...vacationRow
  } = row;

  // Match the row's deletedAt/rejectedAt state so a re-booked day can't merge
  // into the cancelled or rejected run it replaced — both can sit on the same
  // day as the live row now that uniqueness only covers live rows.
  const siblings = await (tx ?? db)
    .select({ id: vacation.id, requestedDay: vacation.requestedDay })
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, vacationRow.userId),
        eq(vacation.groupId, vacationRow.groupId),
        eq(vacation.vacationType, vacationRow.vacationType),
        vacationRow.deletedAt ? isNotNull(vacation.deletedAt) : isNull(vacation.deletedAt),
        vacationRow.rejectedAt ? isNotNull(vacation.rejectedAt) : isNull(vacation.rejectedAt)
      )
    );
  const run = contiguousRunContaining(siblings, vacationRow.requestedDay);
  const resolvedRun =
    run.length > 0 ? run : [{ id: vacationRow.id, requestedDay: vacationRow.requestedDay }];
  const rangeStart = resolvedRun[0]?.requestedDay ?? vacationRow.requestedDay;
  const rangeEnd = resolvedRun[resolvedRun.length - 1]?.requestedDay ?? vacationRow.requestedDay;
  const vacationIds = resolvedRun.map((r) => r.id);

  return {
    ...toListItem(vacationRow),
    groupName,
    rangeStart,
    rangeEnd,
    vacationIds,
    approvedByUser:
      vacationRow.approvedBy && approvedByName
        ? buildUserSummary({ id: vacationRow.approvedBy, name: approvedByName })
        : null,
    rejectedByUser:
      vacationRow.rejectedBy && rejectedByName
        ? buildUserSummary({ id: vacationRow.rejectedBy, name: rejectedByName })
        : null,
    createdByUser:
      vacationRow.createdByUserId && createdByName
        ? buildUserSummary({ id: vacationRow.createdByUserId, name: createdByName })
        : null,
    deletedByUser:
      vacationRow.deletedByUserId && deletedByName
        ? buildUserSummary({ id: vacationRow.deletedByUserId, name: deletedByName })
        : null,
  };
};

export const getVacationById = async (
  vacationId: string,
  tx?: DbTransaction
): Promise<LiveVacationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(vacation)
    .where(and(eq(vacation.id, vacationId), isNull(vacation.deletedAt)));

  // Live by the `isNull` above; nothing checks the narrowing at runtime.
  return row as LiveVacationType | undefined;
};

export type PendingApprovalRow = {
  vacationId: string;
  userId: string;
  userName: string;
  groupId: string;
  groupName: string;
  vacationType: CalendarRecordType;
  requestedDay: string;
  note: string | null;
  submittedAt: Date;
};

/**
 * Returns pending (not yet approved, not rejected, not deleted) vacation rows
 * for groups where the caller may approve — as manager / main approver / temp
 * approver, or through the `approverAccess` membership flag. Rows are ordered
 * by user/group/day so the caller can collapse contiguous ranges into single
 * approval entries. The caller's own requests appear only where the decision
 * endpoints would accept them (see `mayDecideOwn`).
 */
export const getPendingApprovalsForApprover = async (
  approverUserId: string
): Promise<PendingApprovalRow[]> => {
  const approverMembership = alias(groupUsers, "approverMembership");

  const mirroredIntoGroup = exists(
    db
      .select({ one: sql`1` })
      .from(groupMirrors)
      .where(
        and(
          eq(groupMirrors.userId, approverUserId),
          eq(groupMirrors.targetGroupId, vacation.groupId),
          isNull(groupMirrors.deletedAt)
        )
      )
  );

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
    .leftJoin(
      approverMembership,
      and(
        eq(approverMembership.groupId, groups.id),
        eq(approverMembership.userId, approverUserId),
        isNull(approverMembership.deletedAt)
      )
    )
    .where(
      and(
        isNull(vacation.deletedAt),
        isNull(vacation.approvedAt),
        isNull(vacation.rejectedAt),
        isNull(groups.deletedAt),
        or(
          ne(vacation.userId, approverUserId),
          and(eq(approverMembership.approverAccess, true), not(mirroredIntoGroup))
        ),
        or(
          eq(groups.managerUserId, approverUserId),
          eq(groups.mainApprovalUser, approverUserId),
          eq(groups.tempApprovalUser, approverUserId),
          eq(approverMembership.approverAccess, true)
        )
      )
    )
    .orderBy(
      asc(vacation.userId),
      asc(vacation.groupId),
      asc(vacation.vacationType),
      asc(vacation.requestedDay)
    );
};

/**
 * Weighted day totals for one allowance. Scoped to a single group, unlike
 * {@link aggregateUserUsageForYear}, because an allowance is granted per
 * (user, group, year). `excludeVacationIds` leaves out rows the caller is about
 * to decide on and will add back at their post-decision weight.
 */
export const sumCountedDaysForQuota = async (
  userId: string,
  groupId: string,
  year: number,
  calendarRecordType: CalendarRecordType,
  excludeVacationIds: string[] = [],
  tx?: DbTransaction
): Promise<{ approved: number; pending: number }> => {
  const yearStart = `${year.toString().padStart(4, "0")}-01-01`;
  const yearEnd = `${(year + 1).toString().padStart(4, "0")}-01-01`;

  const [row] = await (tx ?? db)
    .select({
      approved: sumDaysWhere(sql`${vacation.approvedAt} IS NOT NULL`),
      pending: sumDaysWhere(sql`${vacation.approvedAt} IS NULL`),
    })
    .from(vacation)
    .where(
      and(
        eq(vacation.userId, userId),
        eq(vacation.groupId, groupId),
        eq(vacation.vacationType, calendarRecordType),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt),
        gte(vacation.requestedDay, yearStart),
        lt(vacation.requestedDay, yearEnd),
        excludeVacationIds.length > 0 ? notInArray(vacation.id, excludeVacationIds) : undefined
      )
    );

  return { approved: Number(row?.approved ?? 0), pending: Number(row?.pending ?? 0) };
};

/**
 * Counts the distinct users with an approved vacation overlapping `today` in
 * any of the supplied group ids.
 */
export const countUsersOutOnDay = async (groupIds: string[], isoDate: string): Promise<number> => {
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
 * Aggregates user vacation usage per calendar record type for the supplied groups
 * and year. Approved (or non-rejected) usage is split into "used" and
 * "pending" buckets matching the `BalanceWidget` shape.
 */
export const aggregateUserUsageForYear = async (
  userId: string,
  groupIds: string[],
  year: number
): Promise<{ type: CalendarRecordType; used: number; pending: number }[]> => {
  if (groupIds.length === 0) return [];
  const yearStart = `${year.toString().padStart(4, "0")}-01-01`;
  const yearEnd = `${(year + 1).toString().padStart(4, "0")}-01-01`;

  const rows = await db
    .select({
      type: vacation.vacationType,
      used: sumDaysWhere(sql`${vacation.approvedAt} IS NOT NULL`),
      pending: sumDaysWhere(sql`${vacation.approvedAt} IS NULL AND ${vacation.rejectedAt} IS NULL`),
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
