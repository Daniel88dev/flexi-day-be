import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { removeBirthday } from "../../services/birthday/birthdayServices.js";
import { markBirthdayTargetsDirty } from "../../services/calendarSync/markCalendarTargetsDirty.js";

export const handleDeleteMyBirthday = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (await removeBirthday(auth.userId)) await markBirthdayTargetsDirty(auth.userId);
  return res.status(204).send();
};
