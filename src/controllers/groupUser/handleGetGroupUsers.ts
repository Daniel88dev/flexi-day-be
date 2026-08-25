import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { validateUserGroupAccess } from "../../services/groupUser/groupAccess.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { getGroupUsers } from "../../services/groupUser/groupUserServices.js";

export const handleGetGroupUsers = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { data: groupId, error: parseError } = z.uuid().safeParse(req.params.groupId);

  if (parseError) {
    throw new AppError({
      message: "Invalid groupId format",
      logging: true,
      code: 400,
      context: {
        url: req.url,
        userId: auth.userId,
        groupId: req.params.groupId,
      },
    });
  }

  const access = await validateUserGroupAccess(auth.userId, groupId);
  if (!access) {
    return res.status(403).json({ message: "No access for related group" });
  }

  const groupUsers = await getGroupUsers(groupId);

  return res.status(200).json(groupUsers);
};
