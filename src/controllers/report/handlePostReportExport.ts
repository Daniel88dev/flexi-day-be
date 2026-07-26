import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import type { ValidatedExportRequest } from "../../services/report/types.js";
import { buildSummaryEntries } from "../../services/report/buildSummary.js";
import { buildReportWorkbook, type SummaryRow } from "../../services/report/excelBuilder.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";

const services = createDBServices();

// Guards against a filter-free export over a large tenant turning into an
// out-of-memory workbook build. Well above any realistic single-year team.
const MAX_EXPORT_BOOKINGS = 50_000;

/**
 * Builds the two-sheet workbook and records who generated it. The audit row
 * is written before the response so a client that disconnects mid-download
 * still leaves a trace of the request.
 */
export const handlePostReportExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedExportRequest = req.body;

  const scope = await services.report.getScopeEntries(auth.userId);
  const filters = { groupIds: data.groupIds, userIds: data.userIds, types: data.types };

  const [bookings, usage, quotas, allMembers] = await Promise.all([
    services.report.getBookingsForScope(
      scope,
      auth.userId,
      data.year,
      filters,
      MAX_EXPORT_BOOKINGS + 1
    ),
    services.report.aggregateUsageSplit(scope, auth.userId, data.year, filters),
    services.report.getQuotasForScope(scope, auth.userId, data.year, {
      groupIds: data.groupIds,
      userIds: data.userIds,
    }),
    services.report.getScopeMembers(scope, auth.userId),
  ]);

  if (bookings.length > MAX_EXPORT_BOOKINGS) {
    throw new AppError({
      message: `Export too large (over ${MAX_EXPORT_BOOKINGS.toString()} rows) — narrow the filters`,
      logging: true,
      code: 413,
      context: { user: auth.userId, year: data.year },
    });
  }

  const members = allMembers.filter(
    (member) =>
      (!data.groupIds || data.groupIds.includes(member.groupId)) &&
      (!data.userIds || data.userIds.includes(member.id))
  );

  const nameByUserId = new Map(members.map((member) => [member.id, member.name]));
  const groupNameById = new Map(scope.map((entry) => [entry.groupId, entry.groupName]));

  const summary: SummaryRow[] = buildSummaryEntries(
    quotas,
    usage,
    members.map((member) => ({ userId: member.id, groupId: member.groupId })),
    data.types
  )
    .map((entry) => ({
      userName: nameByUserId.get(entry.userId) ?? entry.userId,
      groupName: groupNameById.get(entry.groupId) ?? entry.groupId,
      vacationType: entry.vacationType,
      carriedOverDays: entry.carriedOverDays,
      yearQuota: entry.yearQuota,
      usedToDate: entry.usedToDate,
      plannedRemaining: entry.plannedRemaining,
      pending: entry.pending,
      remaining: entry.remaining,
    }))
    .sort((a, b) => a.userName.localeCompare(b.userName) || a.groupName.localeCompare(b.groupName));

  await services.report.recordReportExport({
    id: generateRandomUUID(),
    userId: auth.userId,
    relatedYear: data.year.toString(),
    filters: data,
    rowCount: bookings.length,
  });

  const workbook = await buildReportWorkbook({ year: data.year, summary, bookings });

  const filename = `flexi-day-report-${data.year.toString()}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", workbook.byteLength.toString());
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).send(workbook);
};
