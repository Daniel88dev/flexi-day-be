import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPutGroupApproversType } from "../../services/group/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { db } from "../../db/db.js";

const services = createDBServices();

export const handlePutGroupApprovers = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupApproversType = req.body;

  const access = await services.groupUser.getGroupUser(auth.userId, groupId);

  if (!access || !access.adminAccess) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { url: req.url, user: auth.userId, groupId },
    });
  }

  await assertGroupWritable(groupId);

  const candidates = [data.mainApprovalUser, data.tempApprovalUser].filter(
    (id): id is string => id !== null
  );
  for (const candidate of candidates) {
    const membership = await services.groupUser.getGroupUser(candidate, groupId);
    if (!membership) {
      throw new AppError({
        message: "An approver must be a member of the group",
        logging: true,
        code: 422,
        context: { url: req.url, user: auth.userId, groupId, candidate },
      });
    }
  }

  const updated = await db.transaction(async (tx) => {
    const row = await services.group.updateGroupApprovalUsers(
      groupId,
      data.mainApprovalUser,
      data.tempApprovalUser,
      tx
    );

    if (!row) {
      throw new AppError({
        message: "Group not found",
        logging: true,
        code: 404,
        context: { url: req.url, user: auth.userId, groupId },
      });
    }

    await services.changes.postChanges(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId,
        changeType: changesType.Group,
        changingUserId: auth.userId,
        changeDetail: `Approvers updated (main: ${data.mainApprovalUser}, temp: ${
          data.tempApprovalUser ?? "none"
        })`,
      },
      tx
    );

    return row;
  });

  return res.status(200).json(updated);
};
