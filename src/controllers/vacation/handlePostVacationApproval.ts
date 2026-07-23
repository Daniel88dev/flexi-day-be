import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationDecision } from "../../services/vacation/vacationNotifier.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handlePostVacationApproval = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  const approved = await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(vacationId, tx);
    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    const getApprovers = await services.group.getApprovalUsers(vacationData.groupId, tx);

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

    const row = await services.vacation.approveVacation(vacationId, auth.userId, tx);

    await services.vacationEvent.createVacationEvent(
      {
        id: generateRandomUUID(),
        vacationId,
        eventType: vacationEventType.Approved,
        actorUserId: auth.userId,
      },
      tx
    );

    return row;
  });

  // Post-commit and best-effort: the notifier logs its own failures so a mail
  // problem cannot turn a completed approval into an error for the approver.
  if (approved) {
    await notifyVacationDecision([approved], "approved", {
      id: auth.userId,
      name: auth.userName,
    });
  }

  return res.status(200).json({ message: "Vacation approved" });
};
