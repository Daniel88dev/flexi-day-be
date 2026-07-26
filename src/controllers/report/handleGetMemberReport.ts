import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { validateMemberReportQuery } from "../../services/report/types.js";
import { buildSummaryEntries } from "../../services/report/buildSummary.js";
import AppError from "../../utils/appError.js";
import { buildUserSummary } from "../../utils/userPresentation.js";

const services = createDBServices();

/**
 * One member's year: allowances, monthly usage, every booking, and the
 * admin-made quota changes behind the numbers.
 *
 * Visibility is resolved from the caller's own scope — a member without view
 * access can still open their own detail, but nobody else's.
 */
export const handleGetMemberReport = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const targetUserId = z.string().min(1).parse(req.params.userId);
  const { year } = validateMemberReportQuery.parse(req.query);

  const scope = await services.report.getScopeEntries(auth.userId);
  const isSelf = targetUserId === auth.userId;

  // Looking at someone else is only possible through a group the caller can
  // see in full; their own detail is visible through any membership.
  const searchable = isSelf ? scope : scope.filter((entry) => entry.access === "all");
  const sharedGroupIds = await services.report.getMemberGroupsInScope(
    targetUserId,
    searchable.map((entry) => entry.groupId)
  );

  if (sharedGroupIds.length === 0) {
    throw new AppError({
      message: "No permission to view this member",
      logging: true,
      code: 403,
      context: { url: req.url, user: auth.userId, targetUserId },
    });
  }

  const filters = { groupIds: sharedGroupIds, userIds: [targetUserId] };

  const [member, monthly, usage, quotas, bookings, changes] = await Promise.all([
    services.user.getUserById(targetUserId),
    services.report.aggregateUsageByUserMonth(scope, auth.userId, year, filters),
    services.report.aggregateUsageSplit(scope, auth.userId, year, filters),
    services.report.getQuotasForScope(scope, auth.userId, year, filters),
    services.report.getBookingsForScope(scope, auth.userId, year, filters),
    services.report.getMemberChanges(targetUserId, sharedGroupIds, year),
  ]);

  if (!member) {
    throw new AppError({
      message: "Member not found",
      logging: true,
      code: 404,
      context: { url: req.url, targetUserId },
    });
  }

  const summary = buildSummaryEntries(
    quotas,
    usage,
    sharedGroupIds.map((groupId) => ({ userId: targetUserId, groupId }))
  );

  return res.status(200).json({
    year,
    member: buildUserSummary({ id: member.id, name: member.name }),
    groups: scope.filter((entry) => sharedGroupIds.includes(entry.groupId)),
    quotas,
    summary,
    monthly,
    bookings,
    changes,
  });
};
