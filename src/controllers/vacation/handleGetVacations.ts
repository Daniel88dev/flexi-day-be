import { formatStartAndEndDate } from "../../utils/dateFunc.js";
import { getAuth } from "../../middleware/authSession.js";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  vacationQueryGroupId,
  vacationQueryMonth,
  vacationQueryYear,
  validateVacationListRange,
} from "../../services/vacation/types.js";
import { listVacationsInScope } from "./listVacationsInScope.js";
import AppError from "../../utils/appError.js";

const validateYear = vacationQueryYear.prefault(() => new Date().getFullYear());

const validateMonth = vacationQueryMonth.prefault(() => new Date().getMonth() + 1);

const validateGroupId = vacationQueryGroupId;

const validateFlag = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const parseRange = (query: Request["query"]) => {
  const { from, to } = query;
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined || to === undefined) {
    throw new AppError({ code: 400, message: "from and to must be given together" });
  }
  if (query.year !== undefined || query.month !== undefined) {
    throw new AppError({ code: 400, message: "from/to cannot be combined with year/month" });
  }
  const range = validateVacationListRange.safeParse({ from, to });
  if (!range.success) {
    throw new AppError({
      code: 400,
      message: range.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
  }
  return { startDate: range.data.from, endDate: range.data.to };
};

export const handleGetVacations = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const range =
    parseRange(req.query) ??
    formatStartAndEndDate(validateYear.parse(req.query.year), validateMonth.parse(req.query.month));
  const groupId = validateGroupId.parse(req.query.groupId);
  // Both opt-in, so the dashboard and calendar keep their month-only, live-rows view.
  const includeCancelled = validateFlag.parse(req.query.includeCancelled);
  const wholeRequests = validateFlag.parse(req.query.wholeRequests);

  const rows = await listVacationsInScope(auth.userId, groupId, range, {
    includeCancelled,
    wholeRequests,
  });

  return res.status(200).json(rows);
};
