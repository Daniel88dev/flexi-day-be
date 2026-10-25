import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { db } from "../../db/db.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { postChanges } from "../../services/changes/changesServices.js";
import { getGroup, lockGroup, updateGroupManager } from "../../services/group/groupServices.js";
import type { ValidatedPutGroupManagerType } from "../../services/group/types.js";
import { getGroupUser } from "../../services/groupUser/groupUserServices.js";
import {
  isOrganizationAdmin,
  lockOrganization,
} from "../../services/organization/organizationServices.js";
import { assertNotDeletedAccount } from "../../services/user/userServices.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";

const groupNotFound = (context: Record<string, unknown>) =>
  new AppError({ message: "Group not found", logging: true, code: 404, context });

export const handlePutGroupManager = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const groupId = z.uuid().parse(req.params.groupId);
  const { managerUserId } = req.body as ValidatedPutGroupManagerType;
  const context = { url: req.url, user: auth.userId, groupId, managerUserId };

  const group = await getGroup(groupId);
  if (!group) throw groupNotFound(context);

  if (!(await isOrganizationAdmin(auth.userId, group.organizationId))) {
    throw new AppError({
      message: "Only an organization admin can change a group's manager",
      logging: true,
      code: 403,
      context,
    });
  }

  // The manager approves the group's requests, so naming yourself would turn
  // organization authority into approval authority (docs/invariants.md).
  if (managerUserId === auth.userId) {
    throw new AppError({
      message: "You cannot name yourself the group's manager",
      logging: true,
      code: 403,
      context,
      publicContext: { code: "CANNOT_NAME_SELF" },
    });
  }

  await assertGroupWritable(groupId);

  const updated = await db.transaction(async (tx) => {
    // A removal from the group takes the same lock, so the membership read
    // below still holds when the manager changes.
    await lockOrganization(group.organizationId, tx);
    const previous = await lockGroup(groupId, tx);
    if (!previous) throw groupNotFound(context);

    if (!(await getGroupUser(managerUserId, groupId, tx))) {
      throw new AppError({
        message: "The new manager must be a member of the group",
        logging: true,
        code: 422,
        context,
        publicContext: { code: "NOT_A_MEMBER" },
      });
    }
    await assertNotDeletedAccount(managerUserId, tx, {
      message: "That person deleted their account",
      context,
    });

    const row = await updateGroupManager(groupId, managerUserId, tx);
    if (!row) throw groupNotFound(context);

    await postChanges(
      {
        id: generateRandomUUID(),
        userId: managerUserId,
        groupId,
        changeType: changesType.Group,
        changingUserId: auth.userId,
        changeDetail: `Manager changed (from: ${previous.managerUserId}, to: ${managerUserId})`,
      },
      tx
    );

    return row;
  });

  return res.status(200).json(updated);
};
