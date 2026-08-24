import type { Request, Response } from "express";
import { z } from "zod";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import type { ValidatedPutGroupHolidayCountryType } from "../../services/group/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";
import { postChanges } from "../../services/changes/changesServices.js";
import { updateGroupHolidayCountry } from "../../services/group/groupServices.js";

export const handlePutGroupHolidayCountry = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupHolidayCountryType = req.body;

  await assertGroupAdmin(auth.userId, groupId);

  await assertGroupWritable(groupId);

  const updated = await updateGroupHolidayCountry(groupId, data.holidayCountry);

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
    changeDetail: data.holidayCountry
      ? `Public holidays set to ${data.holidayCountry}`
      : "Public holidays disabled",
  });

  return res.status(200).json(updated);
};
