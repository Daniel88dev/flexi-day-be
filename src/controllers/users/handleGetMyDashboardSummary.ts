import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { formatDateToISOString } from "../../utils/dateFunc.js";
import { collapsePendingApprovals } from "../../services/vacation/collapsePendingApprovals.js";
import { countDistinctUsersInScope } from "../../services/groupUser/groupUserServices.js";
import { getScopeEntries } from "../../services/report/reportServices.js";
import {
  countApprovedVacationsInRange,
  countUsersOutOnDay,
  getPendingApprovalsForApprover,
} from "../../services/vacation/vacationServices.js";

// Installed phone builds send no day, so they keep the UTC date.
const queryParams = z.object({ today: z.iso.date().optional() });

export const handleGetMyDashboardSummary = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { data: query, error: queryError } = queryParams.safeParse(req.query);
  if (queryError) {
    throw new AppError({ message: "Invalid today, expected YYYY-MM-DD", code: 400 });
  }

  const scope = await getScopeEntries(auth.userId);

  const todayIso = query.today ?? formatDateToISOString(new Date());

  // 14-day window starting today: today + the next 13 days. The underlying
  // query uses inclusive bounds on both ends, so +14 here would yield a
  // 15-date range.
  const upcomingEnd = new Date(`${todayIso}T00:00:00Z`);
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 13);
  const upcomingEndIso = formatDateToISOString(upcomingEnd);

  // Same collapse semantics as `GET /api/users/me/approvals` so the stat card
  // matches what the approver actually sees in the widget.
  const [pendingApprovalRows, outTodayCount, upcomingNext14DaysCount, teamSize] = await Promise.all(
    [
      getPendingApprovalsForApprover(auth.userId),
      countUsersOutOnDay(scope, auth.userId, todayIso),
      countApprovedVacationsInRange(scope, auth.userId, todayIso, upcomingEndIso),
      countDistinctUsersInScope(scope, auth.userId),
    ]
  );

  const pendingApprovalsCount = collapsePendingApprovals(pendingApprovalRows).length;

  const workingTodayCount = Math.max(teamSize - outTodayCount, 0);

  return res.status(200).json({
    pendingApprovalsCount,
    outTodayCount,
    workingTodayCount,
    upcomingNext14DaysCount,
    teamSize,
  });
};
