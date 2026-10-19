import { formatStartAndEndDate } from "../../utils/dateFunc.js";
import { getAuth } from "../../middleware/authSession.js";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  vacationQueryGroupId,
  vacationQueryMonth,
  vacationQueryYear,
} from "../../services/vacation/types.js";
import { listVacationsInScope } from "./listVacationsInScope.js";

const validateYear = vacationQueryYear.prefault(() => new Date().getFullYear());

const validateMonth = vacationQueryMonth.prefault(() => new Date().getMonth() + 1);

const validateGroupId = vacationQueryGroupId;

const validateFlag = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

export const handleGetVacations = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const year = validateYear.parse(req.query.year);
  const month = validateMonth.parse(req.query.month);
  const groupId = validateGroupId.parse(req.query.groupId);
  // Both opt-in, so the dashboard and calendar keep their month-only, live-rows view.
  const includeCancelled = validateFlag.parse(req.query.includeCancelled);
  const wholeRequests = validateFlag.parse(req.query.wholeRequests);

  const rows = await listVacationsInScope(
    auth.userId,
    groupId,
    formatStartAndEndDate(year, month),
    { includeCancelled, wholeRequests }
  );

  return res.status(200).json(rows);
};
