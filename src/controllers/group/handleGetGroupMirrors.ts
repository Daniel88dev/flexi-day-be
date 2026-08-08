import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import type { MirrorCandidate, MirrorMember } from "../../services/groupMirror/types.js";

const services = createDBServices();

/**
 * The mirroring setup for one group: for an admin, every member with the
 * sources they may be given; for anyone else, their own mirrors read-only.
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

  if (!membership.adminAccess) {
    const mirrors = await services.groupMirror.getMirrorsIntoGroupForUser(auth.userId, groupId);
    const self: MirrorMember = {
      userId: auth.userId,
      user: buildUserSummary({ id: auth.userId, name: auth.userName }),
      email: auth.userEmail,
      candidates: mirrors.map((mirror) => ({
        groupId: mirror.sourceGroupId,
        groupName: mirror.sourceGroupName,
        mirrored: true,
        manageable: false,
      })),
    };
    return res.status(200).json({ groupId, canManage: false, members: [self] });
  }

  const members = await services.groupUser.getGroupUsers(groupId);
  const memberIds = members.map((member) => member.userId);

  const adminGroupIds = (await services.groupUser.getAdminGroupIdsForUser(auth.userId)).filter(
    (id) => id !== groupId
  );

  const [sourceGroups, membershipPairs, mirrorPairs] = await Promise.all([
    services.group.getAllGroups(adminGroupIds),
    services.groupUser.getMembershipPairs(memberIds, adminGroupIds),
    services.groupMirror.getMirrorsIntoGroupForUsers(memberIds, groupId),
  ]);

  const manageableGroupNames = new Map(sourceGroups.map((group) => [group.id, group.groupName]));

  const manageableFor = new Map<string, Set<string>>();
  for (const pair of membershipPairs) {
    if (!manageableGroupNames.has(pair.groupId)) continue;
    const set = manageableFor.get(pair.userId) ?? new Set<string>();
    set.add(pair.groupId);
    manageableFor.set(pair.userId, set);
  }

  const mirroredFor = new Map<string, Map<string, string>>();
  for (const pair of mirrorPairs) {
    const map = mirroredFor.get(pair.userId) ?? new Map<string, string>();
    map.set(pair.sourceGroupId, pair.sourceGroupName);
    mirroredFor.set(pair.userId, map);
  }

  const payload: MirrorMember[] = members.map((member) => {
    const manageable = manageableFor.get(member.userId) ?? new Set<string>();
    const active = mirroredFor.get(member.userId) ?? new Map<string, string>();

    // Locked, but listed: a save is scoped to `manageable`, so omitting these
    // would read as "no mirror" when there is one.
    const candidateIds = new Set([...manageable, ...active.keys()]);
    const candidates: MirrorCandidate[] = [...candidateIds].map((sourceGroupId) => ({
      groupId: sourceGroupId,
      groupName:
        manageableGroupNames.get(sourceGroupId) ?? active.get(sourceGroupId) ?? sourceGroupId,
      mirrored: active.has(sourceGroupId),
      manageable: manageable.has(sourceGroupId),
    }));
    candidates.sort((a, b) => a.groupName.localeCompare(b.groupName));

    return {
      userId: member.userId,
      user: member.user,
      email: member.email,
      candidates,
    };
  });

  return res.status(200).json({ groupId, canManage: true, members: payload });
};
