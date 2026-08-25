import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { validateReportQuery } from "../../services/report/types.js";
import { buildSummaryEntries } from "../../services/report/buildSummary.js";
import {
  aggregateUsageByUserMonth,
  aggregateUsageSplit,
  getQuotasForScope,
  getScopeEntries,
  getScopeMembers,
} from "../../services/report/reportServices.js";

/**
 * The report's main payload: monthly series per member for the charts, plus
 * the allowance-vs-usage summary the table renders. Both come back scoped to
 * what the caller is allowed to see, with the requested filters applied.
 */
export const handleGetReportOverview = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { year, groupIds, userIds, types } = validateReportQuery.parse(req.query);

  const scope = await getScopeEntries(auth.userId);
  const filters = { groupIds, userIds, types };

  const [monthly, usage, quotas, allMembers] = await Promise.all([
    aggregateUsageByUserMonth(scope, auth.userId, year, filters),
    aggregateUsageSplit(scope, auth.userId, year, filters),
    getQuotasForScope(scope, auth.userId, year, { groupIds, userIds }),
    getScopeMembers(scope, auth.userId),
  ]);

  const selectableMembers = allMembers.filter(
    (member) =>
      (!groupIds || groupIds.includes(member.groupId)) && (!userIds || userIds.includes(member.id))
  );

  const summary = buildSummaryEntries(
    quotas,
    usage,
    selectableMembers.map((member) => ({ userId: member.id, groupId: member.groupId })),
    types
  );

  return res.status(200).json({
    year,
    groups: scope,
    members: selectableMembers,
    monthly,
    summary,
  });
};
