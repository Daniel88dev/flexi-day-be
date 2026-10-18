import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { listGroupEventGroups } from "../../services/groupEvent/groupEventAccess.js";

export const handleGetGroupEventGroups = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  return res.status(200).json(await listGroupEventGroups(auth.userId));
};
