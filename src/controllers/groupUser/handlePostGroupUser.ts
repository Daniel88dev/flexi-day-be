import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { normalizeInviteCode } from "../../utils/inviteCode.js";
import AppError from "../../utils/appError.js";
import { currentYear } from "../../utils/dateFunc.js";
import { assertCanAddMember } from "../../services/billing/guards.js";
import { getGroup } from "../../services/group/groupServices.js";
import { createGroupUser, getGroupUser } from "../../services/groupUser/groupUserServices.js";
import { getInviteLinkByCode, useInviteLink } from "../../services/groupUser/inviteLinkServices.js";
import { openQuotaFromGroupDefaults } from "../../services/userYearQuotas/userYearQuotasServices.js";

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

    if (
      !validateLink ||
      Boolean(validateLink.usedAt) ||
      Boolean(validateLink.revokedAt) ||
      validateLink.expiresAt <= new Date()
    ) {
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
    if (validateLink.email && !auth.emailVerified) {
      throw new AppError({
        message: "Verify your email address before joining a team",
        logging: true,
        code: 403,
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

    const existingMembership = await getGroupUser(auth.userId, validateLink.groupId, tx);

    if (existingMembership) {
      throw new AppError({
        message: "You are already a member of this group",
        logging: true,
        code: 409,
        context: { url: req.url, userId: auth.userId, groupId: validateLink.groupId },
      });
    }

    // The authoritative member-cap gate: runs inside the single-use redemption
    // transaction, where the invite being redeemed still counts as open.
    await assertCanAddMember(validateLink.groupId, tx, { redeemingOpenInvite: true });

    const membership = await createGroupUser(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: validateLink.groupId,
        viewAccess: true,
        adminAccess: false,
        approverAccess: false,
        controlledUser: true,
      },
      tx
    );

    if (!membership) {
      throw new AppError({
        message: "Failed to create group user",
        logging: true,
        code: 500,
        context: {
          url: req.url,
          userId: auth.userId,
          groupId: validateLink.groupId,
          validateLink: validateLink,
        },
      });
    }

    // MUST take `tx`: checking out a second pool connection while this
    // transaction holds one deadlocks the pool at concurrency >= pool size.
    const group = await getGroup(validateLink.groupId, tx);
    await openQuotaFromGroupDefaults(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: validateLink.groupId,
        relatedYear: currentYear().toString(),
        vacationDays: group?.defaultVacationDays ?? 0,
        homeOfficeDays: group?.defaultHomeOfficeDays ?? 0,
        sickDays: group?.defaultSickDays ?? 0,
      },
      tx
    );

    // `usedAt IS NULL` in the update is what makes the code single-use: a
    // concurrent second redemption matches no row and rolls this back.
    const updateInviteLink = await useInviteLink(validationCode, tx);

    if (!updateInviteLink) {
      throw new AppError({
        message: "Failed to update invite link",
        logging: true,
        code: 409,
        context: {
          url: req.url,
          userId: auth.userId,
          groupId: validateLink.groupId,
          validateLink: validateLink,
        },
      });
    }

    return membership;
  });

  return res.status(201).json(result);
};
