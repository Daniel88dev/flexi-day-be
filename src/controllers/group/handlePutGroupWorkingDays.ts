import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../groupUser/utils.js";
import type { ValidatedPutGroupWorkingDaysType } from "../../services/group/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { changesType } from "../../db/schema/changes-schema.js";

const services = createDBServices();

// Sun-first so the label index matches `Date.getUTCDay()`.
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const handlePutGroupWorkingDays = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutGroupWorkingDaysType = req.body;

  await assertGroupAdmin(auth.userId, groupId);

  await assertGroupWritable(groupId);

  const updated = await services.group.updateGroupWorkingDays(groupId, data.workingDays);

  if (!updated) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { url: req.url, user: auth.userId, groupId },
    });
  }

  await services.changes.postChanges({
    id: generateRandomUUID(),
    userId: auth.userId,
    groupId,
    changeType: changesType.Group,
    changingUserId: auth.userId,
    changeDetail: `Group working days set to ${data.workingDays
      .map((d) => WEEKDAY_LABELS.at(d) ?? String(d))
      .join(", ")}`,
  });

  return res.status(200).json(updated);
};
