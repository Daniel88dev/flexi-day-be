import type { DbTransaction } from "../../db/db.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { getGroupAllowancePolicies } from "../group/groupServices.js";
import { getUserYearQuotasForGroups } from "./userYearQuotasServices.js";
import type {
  Allowance,
  GroupAllowancePolicy,
  GroupQuotaDefaults,
  MemberYearAllocation,
  QuotaFigures,
} from "./types.js";

/**
 * Only these calendar record types draw down an allowance. Sick day is metered
 * only where the organization's Sick day benefit is switched on.
 */
export const QUOTA_BEARING_TYPES = [
  CalendarRecordType.Vacation,
  CalendarRecordType.HomeOffice,
  CalendarRecordType.SickDay,
] as const;

export type QuotaBearingType = (typeof QUOTA_BEARING_TYPES)[number];

/**
 * A member's allocation for one year in one group. The booking guard, every
 * reader and the quota rollover go through here, so what a member may book and
 * what their balance and the report show cannot disagree: a missing quota row
 * means the group defaults with nothing carried over.
 */
export const resolveYearAllocation = (
  row: QuotaFigures | undefined,
  defaults: GroupQuotaDefaults | undefined
): QuotaFigures => {
  if (row) {
    return {
      vacationDays: row.vacationDays,
      homeOfficeDays: row.homeOfficeDays,
      sickDays: row.sickDays,
      carriedOverDays: row.carriedOverDays,
    };
  }
  return {
    vacationDays: defaults?.defaultVacationDays ?? 0,
    homeOfficeDays: defaults?.defaultHomeOfficeDays ?? 0,
    sickDays: defaults?.defaultSickDays ?? 0,
    carriedOverDays: 0,
  };
};

/**
 * What one leave type draws from, or null where it is not metered. Sick days
 * are metered only while the organization's Sick day benefit is switched on:
 * legacy SICK_DAY rows from before the benefit stay unmetered.
 */
export function allowanceFor(
  allocation: QuotaFigures,
  type: CalendarRecordType.Vacation | CalendarRecordType.HomeOffice,
  policy: GroupAllowancePolicy | undefined
): Allowance;
export function allowanceFor(
  allocation: QuotaFigures,
  type: CalendarRecordType,
  policy: GroupAllowancePolicy | undefined
): Allowance | null;
export function allowanceFor(
  allocation: QuotaFigures,
  type: CalendarRecordType,
  policy: GroupAllowancePolicy | undefined
): Allowance | null {
  switch (type) {
    case CalendarRecordType.Vacation:
      return { yearQuota: allocation.vacationDays, carriedOverDays: allocation.carriedOverDays };
    case CalendarRecordType.HomeOffice:
      return { yearQuota: allocation.homeOfficeDays, carriedOverDays: 0 };
    case CalendarRecordType.SickDay:
      return policy?.sickDayBenefitEnabled
        ? { yearQuota: allocation.sickDays, carriedOverDays: 0 }
        : null;
    default:
      return null;
  }
}

export const totalAllowance = (allowance: Allowance): number =>
  allowance.yearQuota + allowance.carriedOverDays;

/** One member's allocation in each of the given groups for a year, keyed by group id. */
export const getMemberYearAllocations = async (
  userId: string,
  groupIds: string[],
  year: number,
  tx?: DbTransaction
): Promise<Map<string, MemberYearAllocation>> => {
  if (groupIds.length === 0) return new Map();

  // Sequential: inside a transaction both reads share one connection.
  const rows = await getUserYearQuotasForGroups(userId, groupIds, year.toString(), tx);
  const policies = await getGroupAllowancePolicies(groupIds, tx);

  const rowByGroup = new Map(rows.map((row) => [row.groupId, row]));
  return new Map(
    groupIds.map((groupId) => {
      const policy = policies.get(groupId);
      return [
        groupId,
        { allocation: resolveYearAllocation(rowByGroup.get(groupId), policy), policy },
      ];
    })
  );
};

export const getMemberYearAllocation = async (
  userId: string,
  groupId: string,
  year: number,
  tx?: DbTransaction
): Promise<MemberYearAllocation> => {
  const allocations = await getMemberYearAllocations(userId, [groupId], year, tx);
  return (
    allocations.get(groupId) ?? {
      allocation: resolveYearAllocation(undefined, undefined),
      policy: undefined,
    }
  );
};
