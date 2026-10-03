import type { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import {
  allowanceFor,
  QUOTA_BEARING_TYPES,
  resolveYearAllocation,
  type QuotaBearingType,
} from "../userYearQuotas/yearAllocation.js";
import type { GroupAllowancePolicy } from "../userYearQuotas/types.js";
import type { ReportQuotaRow, ReportUsageSplit } from "./types.js";

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
  vacationType: CalendarRecordType;
};

const key = (userId: string, groupId: string) => `${userId}::${groupId}`;

/**
 * Joins allowances to usage into one line per (member, group, quota type);
 * other record types appear on the export's detail sheet alone.
 *
 * Members appear even with no bookings — a full allowance and nothing taken is
 * exactly what a manager reads a report to find. A member with no quota row
 * reads the group defaults, the same allocation the booking guard enforced.
 *
 * `policies` holds each group's defaults and Sick day toggle; only groups with
 * the benefit on get a Sick day line.
 */
export const buildSummaryEntries = (
  quotas: ReportQuotaRow[],
  usage: UsageEntry[],
  members: { userId: string; groupId: string }[],
  policies: ReadonlyMap<string, GroupAllowancePolicy>,
  types?: CalendarRecordType[]
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
    const policy = policies.get(pair.groupId);
    const allocation = resolveYearAllocation(quotaByKey.get(pairKey), policy);

    for (const type of wanted) {
      const allowance = allowanceFor(allocation, type, policy);
      if (!allowance) continue;

      const { yearQuota, carriedOverDays } = allowance;
      const used = usageByKey.get(`${pairKey}::${type}`);
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
