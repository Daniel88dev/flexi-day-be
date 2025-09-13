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

  const data: ValidatedPostVacationType = req.body;

  const [access] = await getGroupUser(auth.userId, data.groupId);

  if (!access || !access.controlledUser || Boolean(access.deleted)) {
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

  return res.status(200).json(record[0]);
};
