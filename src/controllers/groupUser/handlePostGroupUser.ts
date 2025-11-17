import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

export const handlePostGroupUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { data: validationCode, error: validationCodeError } = z
    .string()
    .safeParse(req.params.validationCode);

  if (validationCodeError) {
    return res.status(400).json({
      message: "Invalid validation code format",
      error: validationCodeError,
    });
  }

  const result = await db.transaction(async (tx) => {
    const validateLink = await services.inviteLinks.getInviteLinkByCode(
      validationCode,
      tx
    );

    if (
      !validateLink ||
      Boolean(validateLink.usedAt) ||
      validateLink.expiresAt <= new Date()
    ) {
      return res
        .status(404)
        .json({ message: "Invalid or expired validation code" });
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

    const updateInviteLink = await services.inviteLinks.useInviteLink(
      validationCode,
      tx
    );

    if (!updateInviteLink) {
      throw new AppError({
        message: "Failed to update invite link",
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

    return createGroupUser;
  });

  //todo email send to group manager

  //todo add history record

  return res.status(201).json(result);
};
