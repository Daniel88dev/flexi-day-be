import type { Request, Response } from "express";
import { z } from "zod";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import type { ValidatedPutGroupQuotasType } from "../../services/group/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { postChanges } from "../../services/changes/changesServices.js";
import { updateGroupQuotas } from "../../services/group/groupServices.js";

/**
 * Updates the group-wide default allowances. A member's allowance is opened
 * from these when they join (`openQuotaFromGroupDefaults`); existing per-year
 * quotas are untouched (they are edited through `/api/quotas/:groupId`).
 */
export const handlePutGroupQuotas = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupQuotasType = req.body;

  await assertGroupAdmin(auth.userId, groupId);

  await assertGroupWritable(groupId);

  const updated = await updateGroupQuotas(
    groupId,
    data.defaultVacationDays,
    data.defaultHomeOfficeDays,
    data.defaultSickDays
  );

  if (!updated) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { url: req.url, user: auth.userId, groupId },
    });
  }

  await postChanges({
    id: generateRandomUUID(),
    userId: auth.userId,
    groupId,
    changeType: changesType.Group,
    changingUserId: auth.userId,
    changeDetail: `Group defaults set to ${data.defaultVacationDays.toString()} vacation / ${data.defaultHomeOfficeDays.toString()} home office / ${data.defaultSickDays.toString()} sick days`,
  });

  return res.status(200).json(updated);
};
