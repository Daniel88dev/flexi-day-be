import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";
import type { MirrorCandidate } from "../../services/groupMirror/types.js";

const services = createDBServices();

/**
 * The caller's mirroring setup for one group: every other group they belong to,
 * and whether their records from it are currently shown here. Mirroring is a
 * per-user choice, so this is scoped to the caller — not the whole group.
 */
export const handleGetGroupMirrors = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  const membership = await services.groupUser.getGroupUser(auth.userId, groupId);
  if (!membership) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
      context: { url: req.url, userId: auth.userId, groupId },
    });
  }

  const [memberships, mirrors] = await Promise.all([
    services.groupUser.getAllGroupsForUser(auth.userId),
    services.groupMirror.getMirrorsIntoGroupForUser(auth.userId, groupId),
  ]);

  const otherGroupIds = memberships.map((row) => row.groupId).filter((id) => id !== groupId);
  const otherGroups = await services.group.getAllGroups(otherGroupIds);
  const mirroredIds = new Set(mirrors.map((mirror) => mirror.sourceGroupId));

  const candidates: MirrorCandidate[] = otherGroups.map((group) => ({
    groupId: group.id,
    groupName: group.groupName,
    mirrored: mirroredIds.has(group.id),
  }));

  return res.status(200).json({ groupId, candidates });
};
