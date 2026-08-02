import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import { vacationType } from "../../db/schema/vacation-schema.js";
import { QUOTA_BEARING_TYPES } from "../report/buildSummary.js";
import { createDBServices } from "../DBServices.js";
import type { VacationType } from "./types.js";

const services = createDBServices();

const isQuotaBearing = (kind: vacationType): boolean =>
  (QUOTA_BEARING_TYPES as readonly vacationType[]).includes(kind);

/** Weight one row draws from an allowance — the SQL side of this is `dayWeight()`. */
const weightOf = (row: { halfDay: boolean }): number => (row.halfDay ? 0.5 : 1);

const yearOf = (isoDay: string): number => Number(isoDay.slice(0, 4));

/**
 * What a member may draw in one group and year. Falls back to the group's
 * defaults when no quota row exists — memberships created before quotas were
 * seeded on join would otherwise be capped at zero, which would block every
 * booking rather than bound it.
 */
const allocationFor = async (
  userId: string,
  groupId: string,
  year: number,
  leaveType: vacationType,
  tx?: DbTransaction
): Promise<number> => {
  const [quota] = await services.userYearQuotas.getUserYearGroupQuotas(
    year.toString(),
    groupId,
    userId,
    tx
  );

  if (quota) {
    return leaveType === vacationType.Vacation
      ? quota.vacationDays + quota.carriedOverDays
      : quota.homeOfficeDays;
  }

  const group = await services.group.getGroup(groupId);
  return leaveType === vacationType.Vacation
    ? (group?.defaultVacationDays ?? 0)
    : (group?.defaultHomeOfficeDays ?? 0);
};

type QuotaCheck = {
  userId: string;
  groupId: string;
  year: number;
  leaveType: vacationType;
  /** Weighted days this operation adds on top of what is already counted. */
  requestedDays: number;
  /** Stored rows whose weight `requestedDays` already accounts for. */
  excludeVacationIds: string[];
};

/**
 * Enforces one member's allowance for one (group, year, leave type).
 *
 * `countPending` is what separates the two call sites: a new request competes
 * with everything already booked, approved or not, so booking counts pending
 * days. A decision only commits days that are actually granted, so approving
 * compares against approved days alone — otherwise a queue of pending requests
 * would block the approver from granting any of them.
 */
const assertOne = async (
  check: QuotaCheck,
  countPending: boolean,
  tx?: DbTransaction
): Promise<void> => {
  if (!isQuotaBearing(check.leaveType)) return;

  const [{ approved, pending }, allocated] = await Promise.all([
    services.vacation.sumCountedDaysForQuota(
      check.userId,
      check.groupId,
      check.year,
      check.leaveType,
      check.excludeVacationIds,
      tx
    ),
    allocationFor(check.userId, check.groupId, check.year, check.leaveType, tx),
  ]);

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

/**
 * Guards a new request against the requester's allowance. `rows` are the
 * per-day records about to be inserted, so nothing is excluded from the
 * existing totals.
 */
export const assertRequestWithinQuota = async (
  rows: {
    userId: string;
    groupId: string;
    requestedDay: string;
    vacationType: vacationType;
    halfDay: boolean;
  }[],
  tx?: DbTransaction
): Promise<void> => {
  await assertGrouped(rows, [], true, tx);
};

/**
 * Guards an approval against the requester's allowance. The rows are already
 * stored and counted as pending, so they are excluded from the running totals
 * and added back as the days the decision is about to grant.
 */
export const assertApprovalWithinQuota = async (
  rows: Pick<
    VacationType,
    "id" | "userId" | "groupId" | "requestedDay" | "vacationType" | "halfDay"
  >[],
  tx?: DbTransaction
): Promise<void> => {
  await assertGrouped(
    rows,
    rows.map((row) => row.id),
    false,
    tx
  );
};

const assertGrouped = async (
  rows: {
    userId: string;
    groupId: string;
    requestedDay: string;
    vacationType: vacationType;
    halfDay: boolean;
  }[],
  excludeVacationIds: string[],
  countPending: boolean,
  tx?: DbTransaction
): Promise<void> => {
  // One allowance per (user, group, year, type) — a range can straddle a year
  // boundary and a bulk decision can span several people at once.
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

  for (const bucket of buckets.values()) {
    await assertOne(bucket, countPending, tx);
  }
};
