import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { assertGroupAdmin } from "./utils.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

/** Revokes an outstanding invite so its code stops working. */
export const handleDeleteGroupInvite = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const inviteId = z.uuid().parse(req.params.inviteId);

  const invite = await services.inviteLinks.getInviteLinkById(inviteId);

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

  const revoked = await services.inviteLinks.revokeInviteLink(inviteId);

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
