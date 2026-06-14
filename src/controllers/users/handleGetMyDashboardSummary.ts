import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { formatDateToISOString } from "../../utils/dateFunc.js";

const services = createDBServices();

export const handleGetMyDashboardSummary = async (
  req: Request,
  res: Response
) => {
  const auth = getAuth(req);

  const visibleGroupIds = (
    await services.groupUser.getAllGroupsForUser(auth.userId)
  ).map((row) => row.groupId);

  const today = new Date();
  const todayIso = formatDateToISOString(
    new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    )
  );

  const upcomingEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 14);
  const upcomingEndIso = formatDateToISOString(upcomingEnd);

  const [
    pendingApprovalsCount,
    outTodayCount,
    upcomingNext14DaysCount,
    teamSize,
  ] = await Promise.all([
    services.vacation.countPendingApprovalsForApprover(auth.userId),
    services.vacation.countUsersOutOnDay(visibleGroupIds, todayIso),
    services.vacation.countApprovedVacationsInRange(
      visibleGroupIds,
      todayIso,
      upcomingEndIso
    ),
    services.groupUser.countDistinctUsersInGroups(visibleGroupIds),
  ]);

  const workingTodayCount = Math.max(teamSize - outTodayCount, 0);

  return res.status(200).json({
    pendingApprovalsCount,
    outTodayCount,
    workingTodayCount,
    upcomingNext14DaysCount,
    teamSize,
  });
};
