import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPostVacationType } from "../../services/vacation/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import {
  expandDateRangeInclusive,
  formatDateToISOString,
} from "../../utils/dateFunc.js";
import { createDBServices } from "../../services/DBServices.js";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";

const services = createDBServices();

export const handlePostVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostVacationType = req.body;

  const fromIso = formatDateToISOString(data.from);
  const toIso = formatDateToISOString(data.to);

  if (toIso < fromIso) {
    throw new AppError({
      message: "`to` must be greater than or equal to `from`",
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso },
    });
  }

  const access = await services.groupUser.getGroupUser(
    auth.userId,
    data.groupId
  );

  if (!access || !access.controlledUser) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
    });
  }

  const days = expandDateRangeInclusive(fromIso, toIso);

  if (days.length === 0) {
    throw new AppError({
      message: "Invalid date range",
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso },
    });
  }

  const records = days.map((day) => ({
    id: generateRandomUUID(),
    userId: auth.userId,
    groupId: data.groupId,
    requestedDay: day,
    startTime: data.startTime,
    endTime: data.endTime,
    vacationType: data.vacationType,
    note: data.note,
  }));

  const created = await db.transaction((tx) =>
    services.vacation.postVacationBulk(records, tx)
  );

  if (created.length === 0) {
    throw new AppError({
      message: "Failed to create vacation",
      logging: true,
      code: 500,
      context: { userId: auth.userId, from: fromIso, to: toIso },
    });
  }

  const groupData = await services.group.getApprovalUsers(data.groupId);

  if (groupData && groupData.mainApprovalUserEmail) {
    // todo construct and send notification email
    logger.info("notification email not-sent (not finished");
  } else if (groupData?.tempApprovalUserEmail) {
    // todo construct and send notification email
    logger.info("notification email not-sent (not finished");
  }

  return res.status(201).json(created);
};
