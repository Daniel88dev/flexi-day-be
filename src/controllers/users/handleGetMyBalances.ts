import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { getAllGroupsForUser } from "../../services/groupUser/groupUserServices.js";
import {
  allowanceFor,
  getMemberYearAllocations,
  QUOTA_BEARING_TYPES,
  totalAllowance,
} from "../../services/userYearQuotas/yearAllocation.js";
import { aggregateUserUsageForYear } from "../../services/vacation/vacationServices.js";

const queryParams = z.object({
  year: z.coerce
    .number()
    .int()
    .min(2023)
    .max(2100)
    .prefault(() => new Date().getFullYear()),
});

type Bucket = {
  type: CalendarRecordType;
  allocated: number;
  used: number;
  pending: number;
};

export const handleGetMyBalances = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { year } = queryParams.parse(req.query);

  const visibleGroupIds = (await getAllGroupsForUser(auth.userId)).map((row) => row.groupId);

  const [allocations, usage] = await Promise.all([
    getMemberYearAllocations(auth.userId, visibleGroupIds, year),
    aggregateUserUsageForYear(auth.userId, visibleGroupIds, year),
  ]);

  const buckets = new Map<CalendarRecordType, Bucket>();
  const ensure = (type: CalendarRecordType): Bucket => {
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

  return res.status(200).json({
    year: year.toString(),
    buckets: Array.from(buckets.values()),
  });
};
