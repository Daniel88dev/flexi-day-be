import { createDBServices } from "../../services/DBServices.js";
import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";

const services = createDBServices();

const validatePostGroup = z.object({
  groupName: z.string().min(1),
  defaultVacation: z.number().min(0).max(99).optional(),
  defaultHomeOffice: z.number().min(0).max(99).optional(),
  mainApprovalUser: z.uuid().optional(),
});

export const handlePostGroup = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const data = validatePostGroup.parse(req.body);

  const result = await db.transaction(async (tx) => {
    const record = await services.group.createGroup(
      {
        id: generateRandomUUID(),
        groupName: data.groupName,
        managerUserId: auth.userId,
        defaultVacationDays: data.defaultVacation,
        defaultHomeOfficeDays: data.defaultHomeOffice,
        mainApprovalUser: data.mainApprovalUser,
      },
      tx
    );

    if (!record) {
      throw new AppError({
        message: "Failed to create group",
        logging: true,
        code: 500,
        context: {
          userId: auth.userId,
          groupName: data.groupName,
          defaultVacation: data.defaultVacation,
          defaultHomeOffice: data.defaultHomeOffice,
        },
      });
    }

    const createGroupUser = await services.groupUser.createGroupUser(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: record.id,
        viewAccess: true,
        adminAccess: true,
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
          groupId: record.id,
        },
      });
    }

    return record;
  });
  return res.status(201).json(result);
};
