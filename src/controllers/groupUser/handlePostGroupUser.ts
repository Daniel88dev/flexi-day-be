import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import { db } from "../../db/db.js";
import { normalizeInviteCode } from "../../utils/inviteCode.js";
import AppError from "../../utils/appError.js";
import { getInviteLinkByCode, inviteStatus } from "../../services/groupUser/inviteLinkServices.js";
import { redeemInvite } from "../../services/groupUser/inviteRedemption.js";

export const handlePostGroupUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { data: rawCode, error: validationCodeError } = z
    .string()
    .min(1)
    .max(64)
    .safeParse(req.params.validationCode);

  const validationCode = rawCode ? normalizeInviteCode(rawCode) : null;

  if (validationCodeError || !validationCode) {
    throw new AppError({
      message: "Invalid validation code format",
      logging: true,
      code: 400,
    });
  }

  const result = await db.transaction(async (tx) => {
    const validateLink = await getInviteLinkByCode(validationCode, tx);

    if (!validateLink || inviteStatus(validateLink) !== "open") {
      throw new AppError({
        message: "Invalid or expired validation code",
        logging: true,
        code: 404,
        context: {
          url: req.url,
          userId: auth.userId,
          validationCode,
        },
      });
    }

    // The address binding below is only worth as much as the address behind it.
    // Social sign-in can hand us a session whose address the provider never
    // vouched for — Microsoft Entra lets a tenant admin set `mail` to any
    // string, and better-auth then marks the account unverified rather than
    // refusing it. Without this, someone controlling their own Entra tenant
    // could claim a colleague's address and redeem an invite issued to them.
    // An unverified invitee joins through the invite link instead, which is
    // itself the proof (`handlePostInviteJoin`).
    if (validateLink.email && !auth.emailVerified) {
      throw new AppError({
        message: "Verify your email address before joining a team",
        logging: true,
        code: 403,
        publicContext: { code: "EMAIL_NOT_VERIFIED_USE_INVITE_LINK" },
        context: {
          url: req.url,
          userId: auth.userId,
        },
      });
    }

    // Invites issued to an address may only be redeemed by that address, so a
    // forwarded or leaked code is useless to anyone else. Rows with no email
    // predate email invites and stay unrestricted.
    if (validateLink.email && validateLink.email !== auth.userEmail.toLowerCase()) {
      throw new AppError({
        message: "This invite was issued for a different email address",
        logging: true,
        code: 403,
        // Kept out of `publicContext`: echoing it back would tell a stranger
        // holding the code whose address it was issued to.
        context: {
          url: req.url,
          userId: auth.userId,
          invitedEmail: validateLink.email,
        },
      });
    }

    return redeemInvite(validateLink, auth.userId, tx, { url: req.url });
  });

  return res.status(201).json(result);
};
