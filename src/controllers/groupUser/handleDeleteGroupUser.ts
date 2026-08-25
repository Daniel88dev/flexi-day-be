import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import {
  getGroup,
  lockGroup,
  updateGroupApprovalUsers,
} from "../../services/group/groupServices.js";
import {
  countActiveMembershipsInOrganization,
  deleteGroupUser,
  getGroupUser,
} from "../../services/groupUser/groupUserServices.js";
import {
  lockOrganization,
  removeOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

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

  const group = await getGroup(groupId);
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

  const membership = await getGroupUser(userId, groupId);
  if (!membership) {
    throw new AppError({
      message: "User is not a member of this group",
      logging: true,
      code: 404,
      context: { url: req.url, userId: auth.userId, groupId, targetUser: userId },
    });
  }

  const removed = await db.transaction(async (tx) => {
    // Organization first, then group — the order every other path takes (see
    // `handlePostGroupInvite`). Reversing it deadlocks against any FK-checked
    // write to `group_users`, which holds the organization lock and then needs
    // a key-share lock on the group.
    await lockOrganization(group.organizationId, tx);

    // Re-read the group under a row lock: the approver columns below are
    // rewritten from the values read here, and the copy fetched before the
    // transaction can already be stale if another admin reassigned approvers.
    const locked = await lockGroup(groupId, tx);
    if (!locked) {
      throw new AppError({
        message: "Group not found",
        logging: true,
        code: 404,
        context: { url: req.url, userId: auth.userId, groupId },
      });
    }

    const row = await deleteGroupUser(membership.id, tx);
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
    if (locked.mainApprovalUser === userId || locked.tempApprovalUser === userId) {
      await updateGroupApprovalUsers(
        groupId,
        locked.mainApprovalUser === userId ? locked.managerUserId : locked.mainApprovalUser,
        locked.tempApprovalUser === userId ? null : locked.tempApprovalUser,
        tx
      );
    }

    // Same reasoning one level up: an org-admin grant is only ever issued to
    // one of the organization's own people, so leaving the last of its groups
    // must end it too. Otherwise someone removed from the company keeps
    // administering every group in it until the owner notices.
    //
    // The count spans the whole organization, which is why the lock taken at
    // the top of this transaction has to be the organization's: two removals
    // from different groups would otherwise each see the other's membership as
    // live and neither would revoke.
    const remaining = await countActiveMembershipsInOrganization(userId, locked.organizationId, tx);
    if (remaining === 0) {
      await removeOrganizationAdmin(locked.organizationId, userId, tx);
    }

    return row;
  });

  return res.status(200).json(removed);
};
