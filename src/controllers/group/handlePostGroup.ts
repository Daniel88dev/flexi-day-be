import { createDBServices } from "../../services/DBServices.js";
import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";

const services = createDBServices();

const validatePostGroup = z.object({
  groupName: z.string().trim().min(1).max(120),
  // `.int()` matters: the columns are `integer`, so a fractional value used to
  // pass validation and then fail in the driver as a 500.
  defaultVacation: z.number().int().min(0).max(99).optional(),
  defaultHomeOffice: z.number().int().min(0).max(99).optional(),
  // better-auth user ids are opaque non-UUID strings.
  mainApprovalUser: z.string().min(1).optional(),
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
        // Without an approver nobody can ever decide on this group's requests
        // and there is no route to set one later, so the creator takes the role
        // by default — the same thing sign-up-with-team does.
        mainApprovalUser: data.mainApprovalUser ?? auth.userId,
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
        // Booking is gated on `controlledUser`, so without this the creator
        // could not take leave in the group they just made.
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
          groupId: record.id,
        },
      });
    }

    await services.userYearQuotas.openQuotaFromGroupDefaults(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: record.id,
        relatedYear: new Date().getFullYear().toString(),
        vacationDays: record.defaultVacationDays,
        homeOfficeDays: record.defaultHomeOfficeDays,
      },
      tx
    );

    return record;
  });
  return res.status(201).json(result);
};
