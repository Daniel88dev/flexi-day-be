import { sql } from "drizzle-orm";
import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import { vacationType } from "../../db/schema/vacation-schema.js";
import { QUOTA_BEARING_TYPES } from "../report/buildSummary.js";
import { createDBServices } from "../DBServices.js";
import type { VacationType } from "./types.js";

const services = createDBServices();

type QuotaRow = {
  userId: string;
  groupId: string;
  requestedDay: string;
  vacationType: vacationType;
  halfDay: boolean;
};

type QuotaCheck = {
  userId: string;
  groupId: string;
  year: number;
  leaveType: vacationType;
  requestedDays: number;
  excludeVacationIds: string[];
};

const isQuotaBearing = (kind: vacationType): boolean =>
  (QUOTA_BEARING_TYPES as readonly vacationType[]).includes(kind);

const weightOf = (row: { halfDay: boolean }): number => (row.halfDay ? 0.5 : 1);

const yearOf = (isoDay: string): number => Number(isoDay.slice(0, 4));

/**
 * Serializes everyone competing for the same allowance. Without it, under READ
 * COMMITTED, concurrent requests all read the pre-insert totals and all pass.
 */
const lockAllowance = async (check: QuotaCheck, tx: DbTransaction): Promise<void> => {
  const key = `${check.userId}::${check.groupId}::${check.year.toString()}::${check.leaveType}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
};

/** Falls back to the group defaults so a membership with no quota row yet is bounded, not blocked. */
const allocationFor = async (check: QuotaCheck, tx: DbTransaction): Promise<number> => {
  const [quota] = await services.userYearQuotas.getUserYearGroupQuotas(
    check.year.toString(),
    check.groupId,
    check.userId,
    tx
  );

  if (quota) {
    return check.leaveType === vacationType.Vacation
      ? quota.vacationDays + quota.carriedOverDays
      : quota.homeOfficeDays;
  }

  const group = await services.group.getGroup(check.groupId, tx);
  return check.leaveType === vacationType.Vacation
    ? (group?.defaultVacationDays ?? 0)
    : (group?.defaultHomeOfficeDays ?? 0);
};

/**
 * `countPending` separates the call sites: booking competes with everything
 * already booked, while approving counts approved days alone — otherwise a
 * queue of pending requests would block the approver from granting any.
 */
const assertOne = async (
  check: QuotaCheck,
  countPending: boolean,
  tx: DbTransaction
): Promise<void> => {
  await lockAllowance(check, tx);

  const { approved, pending } = await services.vacation.sumCountedDaysForQuota(
    check.userId,
    check.groupId,
    check.year,
    check.leaveType,
    check.excludeVacationIds,
    tx
  );
  const allocated = await allocationFor(check, tx);

  const alreadyCounted = countPending ? approved + pending : approved;
  const total = Number((alreadyCounted + check.requestedDays).toFixed(2));

  if (total > allocated) {
    throw new AppError({
      code: 422,
      message: "This would exceed the allowance for that leave type",
      logging: true,
      context: { ...check, approved, pending, allocated, total },
      publicContext: {
        vacationType: check.leaveType,
        year: check.year,
        allocated,
        alreadyCounted,
        requestedDays: check.requestedDays,
        exceededBy: Number((total - allocated).toFixed(2)),
      },
    });
  }
};

const assertGrouped = async (
  rows: QuotaRow[],
  excludeVacationIds: string[],
  countPending: boolean,
  tx: DbTransaction
): Promise<void> => {
  // A range can straddle a year boundary and a bulk decision several people.
  const buckets = new Map<string, QuotaCheck>();

  for (const row of rows) {
    if (!isQuotaBearing(row.vacationType)) continue;
    const year = yearOf(row.requestedDay);
    const key = `${row.userId}::${row.groupId}::${year.toString()}::${row.vacationType}`;
    const bucket = buckets.get(key) ?? {
      userId: row.userId,
      groupId: row.groupId,
      year,
      leaveType: row.vacationType,
      requestedDays: 0,
      excludeVacationIds,
    };
    bucket.requestedDays = Number((bucket.requestedDays + weightOf(row)).toFixed(2));
    buckets.set(key, bucket);
  }

  // Ordered so overlapping batches take their locks alike and cannot deadlock.
  const ordered = Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, bucket]) => bucket);

  for (const bucket of ordered) {
    await assertOne(bucket, countPending, tx);
  }
};

/** Guards a new request. The rows are not stored yet, so nothing is excluded. */
export const assertRequestWithinQuota = async (
  rows: QuotaRow[],
  tx: DbTransaction
): Promise<void> => {
  await assertGrouped(rows, [], true, tx);
};

/**
 * Guards an in-place edit (type or half-day weight change). The edited rows are
 * excluded from the current totals and added back at their post-edit weight;
 * pending days still count, exactly as on create.
 */
export const assertEditWithinQuota = async (
  newStateRows: Pick<
    VacationType,
    "id" | "userId" | "groupId" | "requestedDay" | "vacationType" | "halfDay"
  >[],
  tx: DbTransaction
): Promise<void> => {
  await assertGrouped(
    newStateRows,
    newStateRows.map((row) => row.id),
    true,
    tx
  );
};

/** Rows already count as pending, so they are excluded and added back as granted days. */
export const assertApprovalWithinQuota = async (
  rows: Pick<
    VacationType,
    "id" | "userId" | "groupId" | "requestedDay" | "vacationType" | "halfDay"
  >[],
  tx: DbTransaction
): Promise<void> => {
  await assertGrouped(
    rows,
    rows.map((row) => row.id),
    false,
    tx
  );
};
