import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { paddedMonthRange } from "../../utils/dateFunc.js";
import { validateBirthdayCalendarQuery } from "../../services/birthday/types.js";
import { listBirthdaysInWindow } from "../../services/birthday/birthdayCalendar.js";

// The same window as GET /api/vacation/calendar: the month grid's leading and trailing days.
const ADJACENT_DAYS = 6;

export const handleGetBirthdays = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { year, month, groupId } = validateBirthdayCalendarQuery.parse(req.query);

  const rows = await listBirthdaysInWindow(
    auth.userId,
    groupId,
    paddedMonthRange(year, month, ADJACENT_DAYS)
  );

  return res.status(200).json(rows);
};
