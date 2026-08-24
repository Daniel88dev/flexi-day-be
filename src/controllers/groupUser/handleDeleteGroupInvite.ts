import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import AppError from "../../utils/appError.js";
import {
  getInviteLinkById,
  revokeInviteLink,
} from "../../services/groupUser/inviteLinkServices.js";

/** Revokes an outstanding invite so its code stops working. */
export const handleDeleteGroupInvite = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const inviteId = z.uuid().parse(req.params.inviteId);

  const invite = await getInviteLinkById(inviteId);

  if (!invite) {
    throw new AppError({
      message: "Invite not found",
      logging: true,
      code: 404,
      context: { url: req.url, userId: auth.userId, inviteId },
    });
  }

  // Authorize against the invite's own group — the caller never names it.
  await assertGroupAdmin(auth.userId, invite.groupId);

  const revoked = await revokeInviteLink(inviteId);

  if (!revoked) {
    throw new AppError({
      message: "Invite is already used or revoked",
      logging: true,
      code: 409,
      context: { url: req.url, userId: auth.userId, inviteId },
    });
  }

  return res.status(200).json(revoked);
};
