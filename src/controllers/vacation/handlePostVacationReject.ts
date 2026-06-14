import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedRejectVacationType } from "../../services/vacation/types.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handlePostVacationReject = async (
  req: Request,
  res: Response
) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedRejectVacationType = req.body ?? {};

  await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(
      vacationId,
      tx
    );
    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    const approvers = await services.group.getApprovalUsers(
      vacationData.groupId,
      tx
    );

    if (!approvers) {
      throw new AppError({
        code: 404,
        message: "Not able to verify approvers",
        context: { auth, vacationId },
      });
    }

    if (
      auth.userId !== approvers.mainApprovalUserId &&
      auth.userId !== approvers.tempApprovalUserId
    ) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to reject this vacation",
        context: { auth, vacationId },
      });
    }

    await services.vacation.rejectVacation(
      vacationId,
      auth.userId,
      body.reason ?? null,
      tx
    );
  });

  return res.status(200).json({ message: "Vacation rejected" });
};
