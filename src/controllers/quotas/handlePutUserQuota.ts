import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import type { ValidatedPutUserQuotaType } from "../../services/userYearQuotas/types.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { describeQuotaChange } from "../../services/userYearQuotas/quotaChangeDetail.js";
import { assertGroupWritable } from "../../services/billing/guards.js";

const services = createDBServices();

/**
 * Sets one member's vacation / home-office allowance for a year. Only group
 * admins may call it, and every write is mirrored into the `changes` audit
 * log so an allowance can always be traced back to who granted it.
 */
export const handlePutUserQuota = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutUserQuotaType = req.body;

  const result = await db.transaction(async (tx) => {
    await assertGroupAdmin(auth.userId, groupId, tx);

    const member = await services.groupUser.getGroupUser(data.userId, groupId, tx);

    if (!member) {
      throw new AppError({
        message: "User is not a member of this group",
        logging: true,
        code: 404,
        context: { url: req.url, user: auth.userId, groupId, targetUser: data.userId },
      });
    }

    await assertGroupWritable(groupId, tx);

    const relatedYear = data.year.toString();

    const [existing] = await services.userYearQuotas.getUserYearGroupQuotas(
      relatedYear,
      groupId,
      data.userId,
      tx
    );

    const quota = await services.userYearQuotas.upsertUserYearQuota(
      {
        id: existing?.id ?? generateRandomUUID(),
        userId: data.userId,
        groupId,
        relatedYear,
        vacationDays: data.vacationDays,
        homeOfficeDays: data.homeOfficeDays,
        carriedOverDays: data.carriedOverDays,
      },
      tx
    );

    if (!quota) {
      throw new AppError({
        message: "Failed to update quota",
        logging: true,
        code: 500,
        context: { url: req.url, user: auth.userId, groupId, data },
      });
    }

    await services.changes.postChanges(
      {
        id: generateRandomUUID(),
        userId: data.userId,
        groupId,
        changeType: changesType.UserYearQuotas,
        changingUserId: auth.userId,
        changeDetail: describeQuotaChange(relatedYear, existing, data),
      },
      tx
    );

    return quota;
  });

  return res.status(200).json(result);
};
