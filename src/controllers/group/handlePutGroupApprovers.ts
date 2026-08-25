import type { Request, Response } from "express";
import { z } from "zod";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { getAuth } from "../../middleware/authSession.js";
import { resolveGroupAdmin } from "../../services/groupUser/groupAccess.js";
import type { ValidatedPutGroupApproversType } from "../../services/group/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { db } from "../../db/db.js";
import { postChanges } from "../../services/changes/changesServices.js";
import { getGroup, updateGroupApprovalUsers } from "../../services/group/groupServices.js";
import { getGroupUser } from "../../services/groupUser/groupUserServices.js";

export const handlePutGroupApprovers = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupApproversType = req.body;

  const { canAdmin, viaOrgAdmin } = await resolveGroupAdmin(auth.userId, groupId);
  if (!canAdmin) {
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

  // These columns *are* approval authority, so writing them is the same
  // escalation `handleUpdateGroupUsers` blocks on `approverAccess`. A group's
  // own admin may still do it — a manager naming their team's approver is the
  // normal case — but authority borrowed from the organization may not add an
  // approver at all: blocking only `auth.userId` would leave a delegate free
  // to name a second account of their own instead. Keeping the existing
  // approvers, or removing one, stays allowed.
  if (viaOrgAdmin) {
    const group = await getGroup(groupId);
    const existing = new Set(
      [group?.mainApprovalUser, group?.tempApprovalUser].filter((id): id is string => id != null)
    );
    const added = candidates.filter((candidate) => !existing.has(candidate));

    if (added.length > 0) {
      throw new AppError({
        message: "An organization admin cannot add an approver to this group",
        logging: true,
        code: 403,
        context: { url: req.url, user: auth.userId, groupId, added },
      });
    }
  }

  for (const candidate of candidates) {
    const membership = await getGroupUser(candidate, groupId);
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
    const row = await updateGroupApprovalUsers(
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

    await postChanges(
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
