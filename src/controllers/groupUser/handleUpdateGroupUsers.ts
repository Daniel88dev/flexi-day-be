import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPutGroupUserUpdateType } from "../../services/groupUser/types.js";
import AppError from "../../utils/appError.js";
import { logger } from "../../middleware/logger.js";

const services = createDBServices();

export const handleUpdateGroupUsers = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupUserUpdateType = req.body;

  const access = await services.groupUser.getGroupUser(
    auth.userId,
    data.groupId
  );

  if (!access || !access.adminAccess) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { url: req.url, user: auth.userId, data: data },
    });
  }

  for (const userRecord of data.data) {
    const updatedUser = await services.groupUser.updateGroupUserPermissions(
      userRecord.userId,
      data.groupId,
      {
        viewAccess: userRecord.viewAccess,
        adminAccess: userRecord.adminAccess,
        controlledUser: userRecord.controlledUser,
      }
    );

    if (!updatedUser) {
      throw new AppError({
        message: "Failed to update group user permissions",
        logging: true,
        code: 500,
        context: { url: req.url, user: auth.userId, data: data },
      });
    }

    logger.debug("updateGroupUserPermissions", updatedUser);

    // todo update history record
  }

  return res.status(200).json({ message: "Group users updated successfully" });
};
