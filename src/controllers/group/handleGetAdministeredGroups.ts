import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAdministeredGroups } from "../../services/group/groupListServices.js";

export const handleGetAdministeredGroups = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  return res.status(200).json(await getAdministeredGroups(auth.userId));
};
