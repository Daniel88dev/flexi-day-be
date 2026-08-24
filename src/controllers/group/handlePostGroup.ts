import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { currentYear } from "../../utils/dateFunc.js";
import { assertCanCreateGroup } from "../../services/billing/guards.js";
import { createGroup } from "../../services/group/groupServices.js";
import { createGroupUser } from "../../services/groupUser/groupUserServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { openQuotaFromGroupDefaults } from "../../services/userYearQuotas/userYearQuotasServices.js";

const validatePostGroup = z.object({
  groupName: z.string().trim().min(1).max(120),
  defaultVacation: z.number().int().min(0).max(99).optional(),
  defaultHomeOffice: z.number().int().min(0).max(99).optional(),
  // better-auth user ids are opaque non-UUID strings.
  mainApprovalUser: z.string().min(1).optional(),
});

export const handlePostGroup = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const data = validatePostGroup.parse(req.body);

  // The creator is the only member yet, so nobody else can be a valid approver.
  if (data.mainApprovalUser !== undefined && data.mainApprovalUser !== auth.userId) {
    throw new AppError({
      message: "An approver must be a member of the group",
      logging: true,
      code: 422,
      context: { userId: auth.userId, mainApprovalUser: data.mainApprovalUser },
    });
  }

  const result = await db.transaction(async (tx) => {
    const organization = await ensureOrganizationForUser(auth.userId, tx);

    await assertCanCreateGroup(organization.id, tx);

    const record = await createGroup(
      {
        id: generateRandomUUID(),
        organizationId: organization.id,
        groupName: data.groupName,
        managerUserId: auth.userId,
        defaultVacationDays: data.defaultVacation,
        defaultHomeOfficeDays: data.defaultHomeOffice,
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

    const membership = await createGroupUser(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: record.id,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
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
          groupId: record.id,
        },
      });
    }

    await openQuotaFromGroupDefaults(
      {
        id: generateRandomUUID(),
        userId: auth.userId,
        groupId: record.id,
        relatedYear: currentYear().toString(),
        vacationDays: record.defaultVacationDays,
        homeOfficeDays: record.defaultHomeOfficeDays,
      },
      tx
    );

    return record;
  });
  return res.status(201).json(result);
};
