import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";

const services = createDBServices();

/** The group's still-redeemable invites. Admin-only: the codes are secrets. */
export const handleGetGroupInvites = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  await assertGroupAdmin(auth.userId, groupId);

  const invites = await services.inviteLinks.getOpenInvitesForGroup(groupId);

  return res.status(200).json(invites);
};
