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
} from "../../services/vacation/vacationServices.js";
import AppError from "../../utils/appError.js";
import type { DateString } from "../../utils/dateFunc.js";

/** `range` is half-open: `endDate` itself is excluded. */
export const listVacationsInScope = async (
  userId: string,
  groupId: string | undefined,
  range: { startDate: DateString; endDate: DateString },
  options: { includeCancelled: boolean }
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

  return result.flatMap((row) => {
    const seen = viewVacationRowAs(viewer, row);
    return seen ? [{ ...seen, canApprove: canApprove(row) }] : [];
  });
};
