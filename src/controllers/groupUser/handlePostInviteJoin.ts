import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { hashInviteLinkSecret } from "../../utils/inviteLinkSecret.js";
import {
  getInviteLinkBySecretHash,
  inviteStatus,
} from "../../services/groupUser/inviteLinkServices.js";
import { redeemInvite } from "../../services/groupUser/inviteRedemption.js";
import type { ValidatedInviteLinkTokenType } from "../../services/groupUser/types.js";
import { markEmailVerified } from "../../services/user/userServices.js";

/** Redeems an invite by its link secret and verifies the address: see `docs/invariants.md`. */
export const handlePostInviteJoin = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { token }: ValidatedInviteLinkTokenType = req.body;
  const linkSecretHash = hashInviteLinkSecret(token);

  const membership = await db.transaction(async (tx) => {
    const invite = await getInviteLinkBySecretHash(linkSecretHash, tx);

    if (!invite?.email) {
      throw new AppError({
        message: "Invite not found",
        logging: true,
        code: 404,
        context: { url: req.url, userId: auth.userId },
        publicContext: { code: "INVITE_NOT_FOUND" },
      });
    }

    const status = inviteStatus(invite);
    if (status !== "open") {
      throw new AppError({
        message: `This invite is ${status}`,
        logging: true,
        code: 410,
        context: { url: req.url, userId: auth.userId, inviteId: invite.id },
        publicContext: { code: `INVITE_${status.toUpperCase()}` },
      });
    }

    if (invite.email !== auth.userEmail.toLowerCase()) {
      throw new AppError({
        message: "This invite was issued for a different email address",
        logging: true,
        code: 403,
        context: { url: req.url, userId: auth.userId, inviteId: invite.id },
        publicContext: { code: "INVITE_EMAIL_MISMATCH" },
      });
    }

    const joined = await redeemInvite(invite, auth.userId, tx, { url: req.url });

    if (!auth.emailVerified) {
      await markEmailVerified(auth.userId, tx);
    }

    return joined;
  });

  return res.status(201).json(membership);
};
