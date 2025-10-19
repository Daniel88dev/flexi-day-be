import { createDBServices } from "../../services/DBServices.js";
import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";

const services = createDBServices();

export const handleGetGroups = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groups = (
    await services.groupUser.getAllGroupsForUser(auth.userId)
  ).map((group) => group.groupId);

  const result = await services.group.getAllGroups(groups);

  return res.status(200).json(result);
};
