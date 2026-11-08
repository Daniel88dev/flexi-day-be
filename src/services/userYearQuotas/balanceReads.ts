import type { AuthSession } from "../../middleware/authSession.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { filterGroupIdsByOrganization } from "../group/groupServices.js";
import { getAllGroupsForUser } from "../groupUser/groupUserServices.js";
import { aggregateUserUsageForYear } from "../vacation/vacationServices.js";
import {
  allowanceFor,
  getMemberYearAllocations,
  QUOTA_BEARING_TYPES,
  totalAllowance,
} from "./yearAllocation.js";

export type BalanceBucket = {
  type: CalendarRecordType;
  allocated: number;
  used: number;
  pending: number;
};

/**
 * The caller's allowance and usage for the year, summed across the groups they
 * belong to, or only those of `organizationId` when given.
 */
export const getMyBalances = async (params: {
  auth: AuthSession;
  year: number;
  organizationId?: string;
}): Promise<{ year: string; buckets: BalanceBucket[] }> => {
  const { auth, year, organizationId } = params;

  const memberGroupIds = (await getAllGroupsForUser(auth.userId)).map((row) => row.groupId);
  const visibleGroupIds =
    organizationId === undefined
      ? memberGroupIds
      : await filterGroupIdsByOrganization(memberGroupIds, organizationId);

  const [allocations, usage] = await Promise.all([
    getMemberYearAllocations(auth.userId, visibleGroupIds, year),
    aggregateUserUsageForYear(auth.userId, visibleGroupIds, year),
  ]);

  const buckets = new Map<CalendarRecordType, BalanceBucket>();
  const ensure = (type: CalendarRecordType): BalanceBucket => {
    let bucket = buckets.get(type);
    if (!bucket) {
      bucket = { type, allocated: 0, used: 0, pending: 0 };
      buckets.set(type, bucket);
    }
    return bucket;
  };

  ensure(CalendarRecordType.Vacation);
  ensure(CalendarRecordType.HomeOffice);
  // A Sick day bucket only appears through a group whose organization has the
  // benefit on, so members without it never see an empty one.
  for (const { allocation, policy } of allocations.values()) {
    for (const type of QUOTA_BEARING_TYPES) {
      const allowance = allowanceFor(allocation, type, policy);
      if (!allowance) continue;
      ensure(type).allocated += totalAllowance(allowance);
    }
  }

  for (const row of usage) {
    const bucket = ensure(row.type);
    bucket.used = row.used;
    bucket.pending = row.pending;
  }

  return { year: year.toString(), buckets: Array.from(buckets.values()) };
};
