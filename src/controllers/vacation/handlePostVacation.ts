import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPostVacationType } from "../../services/vacation/types.js";
import { getGroupUser } from "../../services/group_user/getGroupUser.js";
import AppError from "../../utils/appError.js";
import { postVacation } from "../../services/vacation/postVacation.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { formatDateToISOString } from "../../utils/dateFunc.js";

export const handlePostVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostVacationType = req.body;

  const [access] = await getGroupUser(auth.userId, data.groupId);

  if (!access || !access.controlledUser) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
    });
  }

  const record = await postVacation({
    id: generateRandomUUID(),
    userId: auth.userId,
    groupId: data.groupId,
    requestedDay: formatDateToISOString(new Date(data.requestedDay)),
  });

  if (!record) {
    throw new AppError({
      message: "Failed to create vacation",
      logging: true,
      code: 500,
      context: { userId: auth.userId },
      cause: record,
    });
  }

  return res.status(201).json(record);
};
