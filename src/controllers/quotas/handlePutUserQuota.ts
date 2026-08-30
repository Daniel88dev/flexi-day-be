import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import type { ValidatedPutUserQuotaType } from "../../services/userYearQuotas/types.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { describeQuotaChange } from "../../services/userYearQuotas/quotaChangeDetail.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { postChanges } from "../../services/changes/changesServices.js";
import { getGroup } from "../../services/group/groupServices.js";
import { getGroupUser } from "../../services/groupUser/groupUserServices.js";
import {
  getUserYearGroupQuotas,
  upsertUserYearQuota,
} from "../../services/userYearQuotas/userYearQuotasServices.js";

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

    const member = await getGroupUser(data.userId, groupId, tx);

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

    const [existing] = await getUserYearGroupQuotas(relatedYear, groupId, data.userId, tx);

    // Omitted by clients predating the Sick day benefit; preserve rather than
    // wipe — and when this PUT creates the row, start from the group default,
    // the same fallback the quota guard uses for members with no row at all.
    const sickDays =
      data.sickDays ?? existing?.sickDays ?? (await getGroup(groupId, tx))?.defaultSickDays ?? 0;

    // Same preserve-on-omission rule: the group Quotas tab never sends
    // carry-over, and saving an allowance there must not zero it.
    const carriedOverDays = data.carriedOverDays ?? existing?.carriedOverDays ?? 0;

    const quota = await upsertUserYearQuota(
      {
        id: existing?.id ?? generateRandomUUID(),
        userId: data.userId,
        groupId,
        relatedYear,
        vacationDays: data.vacationDays,
        homeOfficeDays: data.homeOfficeDays,
        sickDays,
        carriedOverDays,
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

    await postChanges(
      {
        id: generateRandomUUID(),
        userId: data.userId,
        groupId,
        changeType: changesType.UserYearQuotas,
        changingUserId: auth.userId,
        changeDetail: describeQuotaChange(relatedYear, existing, {
          ...data,
          sickDays,
          carriedOverDays,
        }),
      },
      tx
    );

    return quota;
  });

  return res.status(200).json(result);
};
