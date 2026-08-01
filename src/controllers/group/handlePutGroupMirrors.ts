import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedPutGroupMirrorsType } from "../../services/groupMirror/types.js";

const services = createDBServices();

/**
 * Replaces the caller's mirror sources for one group. Mirroring only ever
 * projects the caller's own records, so membership of the target and of every
 * source group is the whole authorization story — no admin rights are needed
 * and none are enough on someone else's behalf.
 */
export const handlePutGroupMirrors = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const targetGroupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupMirrorsType = req.body;

  if (data.sourceGroupIds.includes(targetGroupId)) {
    throw new AppError({
      message: "A group cannot mirror itself",
      logging: true,
      code: 422,
      context: { url: req.url, userId: auth.userId, targetGroupId },
    });
  }

  const memberships = await services.groupUser.getAllGroupsForUser(auth.userId);
  const memberOf = new Set(memberships.map((row) => row.groupId));

  if (!memberOf.has(targetGroupId)) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
      context: { url: req.url, userId: auth.userId, targetGroupId },
    });
  }

  const notAMember = data.sourceGroupIds.filter((id) => !memberOf.has(id));
  if (notAMember.length > 0) {
    throw new AppError({
      message: "You can only mirror groups you belong to",
      logging: true,
      code: 403,
      context: { url: req.url, userId: auth.userId, targetGroupId, notAMember },
      publicContext: { groupIds: notAMember },
    });
  }

  const mirrors = await db.transaction((tx) =>
    services.groupMirror.setMirrorsIntoGroupForUser(
      auth.userId,
      targetGroupId,
      data.sourceGroupIds,
      tx
    )
  );

  return res.status(200).json(mirrors);
};
