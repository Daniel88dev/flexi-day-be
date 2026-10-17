import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { removeBirthday } from "../../services/birthday/birthdayServices.js";

export const handleDeleteMyBirthday = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  await removeBirthday(auth.userId);
  return res.status(204).send();
};
