import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { paddedMonthRange } from "../../utils/dateFunc.js";
import { validateVacationCalendarQuery } from "../../services/vacation/types.js";
import { listVacationsInScope } from "../../services/vacation/requestReads.js";

// The month grid shows at most 6 days of each neighbouring month in its first and last week.
const ADJACENT_DAYS = 6;

export const handleGetVacationCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { year, month, groupId } = validateVacationCalendarQuery.parse(req.query);

  const rows = await listVacationsInScope({
    auth,
    groupId,
    range: paddedMonthRange(year, month, ADJACENT_DAYS),
    options: { includeCancelled: false },
  });

  return res.status(200).json(rows);
};
