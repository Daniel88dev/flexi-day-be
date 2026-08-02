import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { normalizeInviteCode } from "../../utils/inviteCode.js";
import AppError from "../../utils/appError.js";
import { currentYear } from "../../utils/dateFunc.js";

const services = createDBServices();

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
    const validateLink = await services.inviteLinks.getInviteLinkByCode(validationCode, tx);

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

    const existingMembership = await services.groupUser.getGroupUser(
      auth.userId,
      validateLink.groupId,
      tx
    );

    if (existingMembership) {
      throw new AppError({
        message: "You are already a member of this group",
        logging: true,
        code: 409,
        context: { url: req.url, userId: auth.userId, groupId: validateLink.groupId },
      });
    }

    const createGroupUser = await services.groupUser.createGroupUser(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: validateLink.groupId,
        viewAccess: true,
        adminAccess: false,
        controlledUser: true,
      },
      tx
    );

    if (!createGroupUser) {
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

    const group = await services.group.getGroup(validateLink.groupId);
    await services.userYearQuotas.openQuotaFromGroupDefaults(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: validateLink.groupId,
        relatedYear: currentYear().toString(),
        vacationDays: group?.defaultVacationDays ?? 0,
        homeOfficeDays: group?.defaultHomeOfficeDays ?? 0,
      },
      tx
    );

    // `usedAt IS NULL` in the update is what makes the code single-use: a
    // concurrent second redemption matches no row and rolls this back.
    const updateInviteLink = await services.inviteLinks.useInviteLink(validationCode, tx);

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

    return createGroupUser;
  });

  return res.status(201).json(result);
};
