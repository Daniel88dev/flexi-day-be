import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPostVacationType } from "../../services/vacation/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { formatDateToISOString } from "../../utils/dateFunc.js";
import { createDBServices } from "../../services/DBServices.js";
import { vacationType } from "../../db/schema/vacation-schema.js";
import { logger } from "../../middleware/logger.js";

const services = createDBServices();

export const handlePostVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostVacationType = req.body;

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

  const record = await services.vacation.postVacation({
    id: generateRandomUUID(),
    userId: auth.userId,
    groupId: data.groupId,
    requestedDay: formatDateToISOString(data.requestedDay),
    startTime: data.startTime,
    endTime: data.endTime,
    vacationType: vacationType.Vacation,
  });

  if (!record) {
    throw new AppError({
      message: "Failed to create vacation",
      logging: true,
      code: 500,
      context: { userId: auth.userId },
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

  return res.status(201).json(record);
};
