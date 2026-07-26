import { vacationType } from "../../db/schema/vacation-schema.js";
import type { ReportQuotaRow, ReportUsageSplit } from "./types.js";

/**
 * Only these two leave types draw down an allowance, so only they get a
 * summary line — the rest are reported on the detail sheet alone.
 */
export const QUOTA_BEARING_TYPES = [vacationType.Vacation, vacationType.HomeOffice] as const;

export type QuotaBearingType = (typeof QUOTA_BEARING_TYPES)[number];

export type SummaryEntry = ReportUsageSplit & {
  userId: string;
  groupId: string;
  vacationType: QuotaBearingType;
  carriedOverDays: number;
  yearQuota: number;
  remaining: number;
};

type UsageEntry = ReportUsageSplit & {
  userId: string;
  groupId: string;
  vacationType: vacationType;
};

const key = (userId: string, groupId: string) => `${userId}::${groupId}`;

/**
 * Joins allowances to usage into one line per (member, group, quota type).
 *
 * Members appear even with no bookings — a full allowance and nothing taken is
 * exactly what a manager reads a report to find. Carry-over belongs to the
 * vacation allowance only; the column exists once on the quota row and would
 * otherwise be double-counted against home office.
 */
export const buildSummaryEntries = (
  quotas: ReportQuotaRow[],
  usage: UsageEntry[],
  members: { userId: string; groupId: string }[],
  types?: vacationType[]
): SummaryEntry[] => {
  const wanted = QUOTA_BEARING_TYPES.filter((type) => !types || types.includes(type));
  if (wanted.length === 0) return [];

  const quotaByKey = new Map(quotas.map((row) => [key(row.userId, row.groupId), row]));
  const usageByKey = new Map<string, UsageEntry>();
  for (const row of usage) {
    usageByKey.set(`${key(row.userId, row.groupId)}::${row.vacationType}`, row);
  }

  const pairs = new Map<string, { userId: string; groupId: string }>();
  for (const source of [members, quotas, usage]) {
    for (const row of source) pairs.set(key(row.userId, row.groupId), row);
  }

  const entries: SummaryEntry[] = [];

  for (const pair of pairs.values()) {
    const pairKey = key(pair.userId, pair.groupId);
    const quota = quotaByKey.get(pairKey);

    for (const type of wanted) {
      const used = usageByKey.get(`${pairKey}::${type}`);
      const isVacation = type === vacationType.Vacation;
      const carriedOverDays = isVacation ? (quota?.carriedOverDays ?? 0) : 0;
      const yearQuota = isVacation ? (quota?.vacationDays ?? 0) : (quota?.homeOfficeDays ?? 0);
      const usedToDate = used?.usedToDate ?? 0;
      const plannedRemaining = used?.plannedRemaining ?? 0;

      entries.push({
        userId: pair.userId,
        groupId: pair.groupId,
        vacationType: type,
        carriedOverDays,
        yearQuota,
        usedToDate,
        plannedRemaining,
        pending: used?.pending ?? 0,
        remaining: Number((carriedOverDays + yearQuota - usedToDate - plannedRemaining).toFixed(2)),
      });
    }
  }

  return entries;
};
