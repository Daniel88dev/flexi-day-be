import { formatStartAndEndDate } from "../../utils/dateFunc.js";
import { getAuth } from "../../middleware/authSession.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";

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

const validateUUID = z.uuid().optional().catch(undefined);

export const handleGetVacations = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const year = validateYear.parse(req.query.year);
  const month = validateMonth.parse(req.query.month);
  const groupId = validateUUID.parse(req.query.groupId);

  const range = formatStartAndEndDate(year, month);

  const result = await services.vacation.getVacation(
    auth.userId,
    range.startDate,
    range.endDate,
    groupId
  );

  return res.status(200).json(result);
};
