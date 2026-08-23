import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPutGroupUserUpdateType } from "../../services/groupUser/types.js";
import { resolveGroupAdmin } from "../../services/groupUser/groupAccess.js";
import AppError from "../../utils/appError.js";
import { logger } from "../../middleware/logger.js";
import { db } from "../../db/db.js";

const services = createDBServices();

export const handleUpdateGroupUsers = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupUserUpdateType = req.body;

  const { canAdmin, viaOrgAdmin } = await resolveGroupAdmin(auth.userId, data.groupId);
  if (!canAdmin) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { url: req.url, user: auth.userId, groupId: data.groupId },
    });
  }

  // Authority borrowed from the organization administers a group; it never
  // creates approval authority in one — not for the caller, and not for anyone
  // else either, or a delegate would route around the self-check below by
  // inviting a second account of their own and promoting that. Clearing
  // `approverAccess` stays allowed: taking rights away is always safe.
  if (viaOrgAdmin) {
    const current = await services.groupUser.getGroupUsers(data.groupId);
    const approverBefore = new Map(current.map((row) => [row.userId, row.approverAccess]));
    const grantsApprover = data.data.some(
      (record) => record.approverAccess && !approverBefore.get(record.userId)
    );

    if (grantsApprover) {
      throw new AppError({
        message: "An organization admin cannot grant approver rights in this group",
        logging: true,
        code: 403,
        context: { url: req.url, user: auth.userId, groupId: data.groupId },
      });
    }
  }

  // Nobody may raise their own permissions, only keep or lower them. Every
  // record for the caller, not just the first: the loop below applies them all
  // in order, so a duplicated entry would otherwise let a harmless first
  // record pass the check while a later one does the raising.
  const selfRecords = data.data.filter((record) => record.userId === auth.userId);
  if (selfRecords.length > 0) {
    const current = await services.groupUser.getGroupUser(auth.userId, data.groupId);
    const raises = selfRecords.some(
      (self) =>
        (self.viewAccess && !current?.viewAccess) ||
        (self.adminAccess && !current?.adminAccess) ||
        (self.approverAccess && !current?.approverAccess)
    );

    if (raises) {
      throw new AppError({
        message: "You cannot raise your own permissions in a group",
        logging: true,
        code: 403,
        context: { url: req.url, user: auth.userId, groupId: data.groupId },
      });
    }
  }

  await db.transaction(async (tx) => {
    for (const userRecord of data.data) {
      const updatedUser = await services.groupUser.updateGroupUserPermissions(
        userRecord.userId,
        data.groupId,
        {
          viewAccess: userRecord.viewAccess,
          adminAccess: userRecord.adminAccess,
          approverAccess: userRecord.approverAccess,
          controlledUser: userRecord.controlledUser,
        },
        tx
      );

      if (!updatedUser) {
        throw new AppError({
          message: "Failed to update group user permissions",
          logging: true,
          code: 400,
          context: { url: req.url, user: auth.userId, data: data },
        });
      }

      logger.debug("updateGroupUserPermissions", updatedUser);

      // todo update history record
    }
  });

  return res.status(200).json({ message: "Group users updated successfully" });
};
