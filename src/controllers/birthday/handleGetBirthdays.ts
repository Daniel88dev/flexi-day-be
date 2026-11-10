import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { validateBirthdayCalendarQuery } from "../../services/birthday/types.js";
import { listBirthdaysForMonth } from "../../services/birthday/birthdayCalendar.js";

export const handleGetBirthdays = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { year, month, groupId } = validateBirthdayCalendarQuery.parse(req.query);

  return res.status(200).json(await listBirthdaysForMonth({ auth, year, month, groupId }));
};
