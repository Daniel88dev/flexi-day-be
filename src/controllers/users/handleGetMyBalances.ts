import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { vacationType } from "../../db/schema/vacation-schema.js";

const services = createDBServices();

const queryParams = z.object({
  year: z.coerce
    .number()
    .int()
    .min(2023)
    .max(2100)
    .prefault(() => new Date().getFullYear()),
});

type Bucket = {
  type: vacationType;
  allocated: number;
  used: number;
  pending: number;
};

export const handleGetMyBalances = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { year } = queryParams.parse(req.query);

  const visibleGroupIds = (
    await services.groupUser.getAllGroupsForUser(auth.userId)
  ).map((row) => row.groupId);

  const [quotaSums, usage] = await Promise.all([
    services.userYearQuotas.sumUserQuotasForYear(
      auth.userId,
      visibleGroupIds,
      year.toString()
    ),
    services.vacation.aggregateUserUsageForYear(
      auth.userId,
      visibleGroupIds,
      year
    ),
  ]);

  const buckets = new Map<vacationType, Bucket>();
  const ensure = (type: vacationType): Bucket => {
    let bucket = buckets.get(type);
    if (!bucket) {
      bucket = { type, allocated: 0, used: 0, pending: 0 };
      buckets.set(type, bucket);
    }
    return bucket;
  };

  ensure(vacationType.Vacation).allocated = quotaSums.vacationDays;
  ensure(vacationType.HomeOffice).allocated = quotaSums.homeOfficeDays;

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
