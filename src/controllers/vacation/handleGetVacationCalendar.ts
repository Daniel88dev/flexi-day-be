import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { paddedMonthRange } from "../../utils/dateFunc.js";
import { validateVacationCalendarQuery } from "../../services/vacation/types.js";
import { listVacationsInScope } from "./listVacationsInScope.js";

// The month grid shows at most 6 days of each neighbouring month in its first and last week.
const ADJACENT_DAYS = 6;

export const handleGetVacationCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { year, month, groupId } = validateVacationCalendarQuery.parse(req.query);

  const rows = await listVacationsInScope(
    auth.userId,
    groupId,
    paddedMonthRange(year, month, ADJACENT_DAYS),
    { includeCancelled: false }
  );

  return res.status(200).json(rows);
};
