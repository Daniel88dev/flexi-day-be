import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { assertGroupAdmin } from "./utils.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";

const services = createDBServices();

/**
 * Removes a member from a group (soft delete). This is also how a downgraded
 * owner gets back under their plan's member limit, so it must never be gated
 * on the group being writable.
 */
export const handleDeleteGroupUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);
  // better-auth user ids are opaque non-UUID strings.
  const userId = z.string().min(1).max(128).parse(req.params.userId);

  await assertGroupAdmin(auth.userId, groupId);

  const group = await services.group.getGroup(groupId);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { url: req.url, userId: auth.userId, groupId },
    });
  }

  if (group.managerUserId === userId) {
    throw new AppError({
      message: "The group manager cannot be removed — transfer the group first",
      logging: true,
      code: 409,
      context: { url: req.url, userId: auth.userId, groupId },
    });
  }

  const membership = await services.groupUser.getGroupUser(userId, groupId);
  if (!membership) {
    throw new AppError({
      message: "User is not a member of this group",
      logging: true,
      code: 404,
      context: { url: req.url, userId: auth.userId, groupId, targetUser: userId },
    });
  }

  const removed = await db.transaction(async (tx) => {
    const row = await services.groupUser.deleteGroupUser(membership.id, tx);
    if (!row) {
      throw new AppError({
        message: "Failed to remove group member",
        logging: true,
        code: 409,
        context: { url: req.url, userId: auth.userId, groupId, targetUser: userId },
      });
    }

    // A former member must not keep approval rights through the group's
    // approver columns: main falls back to the manager, temp is cleared.
    if (group.mainApprovalUser === userId || group.tempApprovalUser === userId) {
      await services.group.updateGroupApprovalUsers(
        groupId,
        group.mainApprovalUser === userId ? group.managerUserId : group.mainApprovalUser,
        group.tempApprovalUser === userId ? null : group.tempApprovalUser,
        tx
      );
    }

    return row;
  });

  return res.status(200).json(removed);
};
