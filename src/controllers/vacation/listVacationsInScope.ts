import { canViewWholeGroup } from "../../services/report/reportScope.js";
import { getReportScopeEntries } from "../../services/report/reportServices.js";
import {
  resolveCanApproveForList,
  resolveVacationViewer,
} from "../../services/vacation/vacationPermissions.js";
import { viewVacationRowAs } from "../../services/vacation/redaction.js";
import {
  getVacationsForGroup,
  getVacationsForUser,
  type VacationListOptions,
} from "../../services/vacation/vacationServices.js";
import AppError from "../../utils/appError.js";
import type { DateString } from "../../utils/dateFunc.js";

/** `range` is half-open: `endDate` itself is excluded. */
export const listVacationsInScope = async (
  userId: string,
  groupId: string | undefined,
  range: { startDate: DateString; endDate: DateString },
  options: VacationListOptions
) => {
  if (groupId === undefined) {
    const result = await getVacationsForUser(userId, range.startDate, range.endDate, options);
    const canApprove = await resolveCanApproveForList(userId, result);
    // Same shape either way, so clients do not branch on scope.
    return result.map((row) => ({
      ...row,
      mirroredFromGroupId: null,
      mirroredFromGroupName: null,
      canApprove: canApprove(row),
    }));
  }

  const scope = await getReportScopeEntries(userId);
  if (!canViewWholeGroup(scope, groupId)) {
    throw new AppError({
      code: 403,
      message: "No access to view this group's records",
      logging: true,
      context: { userId, groupId },
    });
  }

  const result = await getVacationsForGroup(groupId, range.startDate, range.endDate, null, options);
  const canApprove = await resolveCanApproveForList(userId, result);
  const viewer = await resolveVacationViewer(
    userId,
    result.map((row) => row.groupId)
  );

  const visible = result.flatMap((row) => {
    const seen = viewVacationRowAs(viewer, row);
    return seen ? [{ ...seen, canApprove: canApprove(row) }] : [];
  });
  return options.wholeRequests ? keepRequestsVisibleInRange(visible, range) : visible;
};

// The service picks Requests by their raw in-range rows. A teammate may not see those rows
// (rejected, cancelled), and then gets none of that Request's rows from other months either.
const keepRequestsVisibleInRange = <T extends { requestId: string; requestedDay: string }>(
  rows: T[],
  range: { startDate: DateString; endDate: DateString }
): T[] => {
  const inRange = new Set(
    rows
      .filter((row) => row.requestedDay >= range.startDate && row.requestedDay < range.endDate)
      .map((row) => row.requestId)
  );
  return rows.filter((row) => inRange.has(row.requestId));
};
