import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedPutGroupMirrorsType } from "../../services/groupMirror/types.js";

const services = createDBServices();

/**
 * Replaces one member's mirror sources for a group. Not self-service: the
 * caller must administer the target group *and* every source group they touch,
 * or projecting a group's records would need rights on the receiving side only.
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

  const access = await services.groupUser.getGroupUser(auth.userId, targetGroupId);
  if (!access?.adminAccess) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { url: req.url, userId: auth.userId, targetGroupId },
    });
  }

  const targetMembership = await services.groupUser.getGroupUser(data.userId, targetGroupId);
  if (!targetMembership) {
    throw new AppError({
      message: "Mirroring can only be set up for a member of this group",
      logging: true,
      code: 422,
      context: { url: req.url, userId: auth.userId, targetGroupId, memberId: data.userId },
    });
  }

  const adminGroupIds = (await services.groupUser.getAdminGroupIdsForUser(auth.userId)).filter(
    (id) => id !== targetGroupId
  );
  const adminOf = new Set(adminGroupIds);

  const notAdminOf = data.sourceGroupIds.filter((id) => !adminOf.has(id));
  if (notAdminOf.length > 0) {
    throw new AppError({
      message: "You can only mirror from groups you administer",
      logging: true,
      code: 403,
      context: { url: req.url, userId: auth.userId, targetGroupId, notAdminOf },
      publicContext: { groupIds: notAdminOf },
    });
  }

  const memberOfSources = new Set(
    (await services.groupUser.getMembershipPairs([data.userId], data.sourceGroupIds)).map(
      (pair) => pair.groupId
    )
  );
  const notAMember = data.sourceGroupIds.filter((id) => !memberOfSources.has(id));
  if (notAMember.length > 0) {
    throw new AppError({
      message: "A member can only be mirrored from groups they belong to",
      logging: true,
      code: 422,
      context: { url: req.url, userId: auth.userId, targetGroupId, notAMember },
      publicContext: { groupIds: notAMember },
    });
  }

  const mirrors = await db.transaction((tx) =>
    services.groupMirror.setMirrorsIntoGroupForUser(
      data.userId,
      targetGroupId,
      data.sourceGroupIds,
      adminGroupIds,
      tx
    )
  );

  return res.status(200).json(mirrors);
};
