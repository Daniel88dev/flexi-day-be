import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getBirthdaySettings } from "../../services/birthday/birthdayVisibility.js";

export const handleGetMyBirthday = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  return res.status(200).json(await getBirthdaySettings(auth.userId));
};
