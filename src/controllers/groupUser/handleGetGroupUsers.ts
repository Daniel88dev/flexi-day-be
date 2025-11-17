import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { validateUserGroupAccess } from "./utils.js";
import { z } from "zod";

const services = createDBServices();

export const handleGetGroupUsers = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { data: groupId, error: parseError } = z
    .uuid("")
    .safeParse(req.params.groupId);

  if (parseError) {
    return res
      .status(400)
      .json({ message: "Invalid groupId format", error: parseError });
  }

  const access = await validateUserGroupAccess(auth.userId, groupId);
  if (!access) {
    return res.status(403).json({ message: "No access for related group" });
  }

  const groupUsers = await services.groupUser.getGroupUsers(groupId);

  return res.status(200).json(groupUsers);
};
