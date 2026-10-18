import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getBirthday, saveBirthday } from "../../services/birthday/birthdayServices.js";
import {
  assertCanShareBirthday,
  getBirthdaySettings,
} from "../../services/birthday/birthdayVisibility.js";
import type { PutBirthdayBody } from "../../services/birthday/types.js";
import { markBirthdayTargetsDirty } from "../../services/calendarSync/markCalendarTargetsDirty.js";

/**
 * Only switching sharing on asks the plan. A switch already on stays on after
 * every paid group lapses, so editing the date then must not trip the check.
 */
export const handlePutMyBirthday = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as PutBirthdayBody;

  const current = await getBirthday(auth.userId);
  const sharedNow = current !== null && current.deletedAt === null && current.shared;
  if (body.shared && !sharedNow) await assertCanShareBirthday(auth.userId);

  await saveBirthday(auth.userId, body);
  await markBirthdayTargetsDirty(auth.userId);

  return res.status(200).json(await getBirthdaySettings(auth.userId));
};
