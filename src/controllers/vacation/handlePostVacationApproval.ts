import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handlePostVacationApproval = async (
  req: Request,
  res: Response
) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  const vacationData = await services.vacation.getVacationById(vacationId);
  if (!vacationData) {
    throw new AppError({
      code: 404,
      message: "Vacation not found",
      context: { auth, vacationId },
    });
  }

  const getApprovers = await services.group.getApprovalUsers(
    vacationData.groupId
  );

  if (!getApprovers) {
    throw new AppError({
      code: 404,
      message: "Not able to verify approvers",
      context: { auth, vacationId },
    });
  }

  if (
    auth.userId !== getApprovers.mainApprovalUserId &&
    auth.userId !== getApprovers.tempApprovalUserId
  ) {
    throw new AppError({
      code: 403,
      message: "You are not allowed to approve this vacation",
      context: { auth, vacationId },
    });
  }

  await services.vacation.approveVacation(vacationId, auth.userId);

  return res.status(200).json({ message: "Vacation approved" });
};
