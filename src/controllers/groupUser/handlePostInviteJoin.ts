import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { hashInviteLinkSecret } from "../../utils/inviteLinkSecret.js";
import { getInviteLinkBySecretHash } from "../../services/groupUser/inviteLinkServices.js";
import { assertOpenInviteFor, redeemInvite } from "../../services/groupUser/inviteRedemption.js";
import type { ValidatedInviteLinkTokenType } from "../../services/groupUser/types.js";
import { markEmailVerified } from "../../services/user/userServices.js";

/** Redeems an invite by its link secret and verifies the address: see `docs/invariants.md`. */
export const handlePostInviteJoin = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { token }: ValidatedInviteLinkTokenType = req.body;
  const linkSecretHash = hashInviteLinkSecret(token);

  const membership = await db.transaction(async (tx) => {
    const invite = assertOpenInviteFor(
      await getInviteLinkBySecretHash(linkSecretHash, tx),
      auth.userEmail.toLowerCase(),
      { url: req.url, userId: auth.userId }
    );

    const joined = await redeemInvite(invite, auth.userId, tx, { url: req.url });

    if (!auth.emailVerified) {
      await markEmailVerified(auth.userId, tx);
    }

    return joined;
  });

  return res.status(201).json(membership);
};
