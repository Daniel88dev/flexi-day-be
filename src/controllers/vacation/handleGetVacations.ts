import { formatStartAndEndDate } from "../../utils/dateFunc.js";
import { getAuth } from "../../middleware/authSession.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { canViewWholeGroup } from "../../services/report/reportScope.js";
import AppError from "../../utils/appError.js";
import { resolveCanApproveForList } from "../../services/vacation/vacationPermissions.js";

const services = createDBServices();

const validateYear = z.coerce
  .number()
  .int()
  .min(2023)
  .max(2050)
  .prefault(() => new Date().getFullYear());

const validateMonth = z.coerce
  .number()
  .int()
  .min(1)
  .max(12)
  .prefault(() => new Date().getMonth() + 1);

const validateGroupId = z.string().min(1).optional();

// Opt-in: the calendar and dashboard keep their live-rows-only view.
const validateIncludeCancelled = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

export const handleGetVacations = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const year = validateYear.parse(req.query.year);
  const month = validateMonth.parse(req.query.month);
  const groupId = validateGroupId.parse(req.query.groupId);
  const includeCancelled = validateIncludeCancelled.parse(req.query.includeCancelled);

  const range = formatStartAndEndDate(year, month);

  if (groupId === undefined) {
    const result = await services.vacation.getVacationsForUser(
      auth.userId,
      range.startDate,
      range.endDate,
      { includeCancelled }
    );
    const canApprove = await resolveCanApproveForList(auth.userId, result);
    // Same shape either way, so the calendar does not branch on scope.
    return res.status(200).json(
      result.map((row) => ({
        ...row,
        mirroredFromGroupId: null,
        mirroredFromGroupName: null,
        canApprove: canApprove(row),
      }))
    );
  }

  const scope = await services.report.getScopeEntries(auth.userId);
  if (!canViewWholeGroup(scope, groupId)) {
    throw new AppError({
      code: 403,
      message: "No access to view this group's records",
      logging: true,
      context: { userId: auth.userId, groupId },
    });
  }

  const result = await services.vacation.getVacationsForGroup(
    groupId,
    range.startDate,
    range.endDate,
    null,
    { includeCancelled }
  );
  const canApprove = await resolveCanApproveForList(auth.userId, result);

  return res.status(200).json(result.map((row) => ({ ...row, canApprove: canApprove(row) })));
};
