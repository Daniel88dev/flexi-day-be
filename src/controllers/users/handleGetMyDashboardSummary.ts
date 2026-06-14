import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { formatDateToISOString } from "../../utils/dateFunc.js";
import { collapsePendingApprovals } from "../../services/vacation/collapsePendingApprovals.js";

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

  // 14-day window starting today: today + the next 13 days. The underlying
  // query uses inclusive bounds on both ends, so +14 here would yield a
  // 15-date range.
  const upcomingEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 13);
  const upcomingEndIso = formatDateToISOString(upcomingEnd);

  // Same collapse semantics as `GET /api/users/me/approvals` so the stat card
  // matches what the approver actually sees in the widget.
  const [
    pendingApprovalRows,
    outTodayCount,
    upcomingNext14DaysCount,
    teamSize,
  ] = await Promise.all([
    services.vacation.getPendingApprovalsForApprover(auth.userId),
    services.vacation.countUsersOutOnDay(visibleGroupIds, todayIso),
    services.vacation.countApprovedVacationsInRange(
      visibleGroupIds,
      todayIso,
      upcomingEndIso
    ),
    services.groupUser.countDistinctUsersInGroups(visibleGroupIds),
  ]);

  const pendingApprovalsCount =
    collapsePendingApprovals(pendingApprovalRows).length;

  const workingTodayCount = Math.max(teamSize - outTodayCount, 0);

  return res.status(200).json({
    pendingApprovalsCount,
    outTodayCount,
    workingTodayCount,
    upcomingNext14DaysCount,
    teamSize,
  });
};
