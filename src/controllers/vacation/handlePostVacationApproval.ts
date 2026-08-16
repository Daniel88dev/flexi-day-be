import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationDecision } from "../../services/vacation/vacationNotifier.js";
import type { ValidatedApproveVacationType } from "../../services/vacation/types.js";
import { assertApprovalWithinQuota } from "../../services/vacation/quotaGuard.js";
import { assertMayDecide, assertStillPending } from "./decisionGuards.js";
import { assertGroupWritable } from "../../services/billing/guards.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handlePostVacationApproval = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedApproveVacationType = req.body ?? {};

  const approved = await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(vacationId, tx);
    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    await assertMayDecide(auth.userId, [vacationData], "approve", tx);
    assertStillPending([vacationData]);
    await assertGroupWritable(vacationData.groupId, tx);
    await assertApprovalWithinQuota([vacationData], tx);

    const row = await services.vacation.approveVacation(vacationId, auth.userId, tx);

    // Lost race: decided between the read above and this update.
    if (!row) {
      throw new AppError({
        code: 409,
        message: "This request has already been decided",
        logging: true,
        context: { auth, vacationId },
      });
    }

    await services.vacationEvent.createVacationEvent(
      {
        id: generateRandomUUID(),
        vacationId,
        eventType: vacationEventType.Approved,
        actorUserId: auth.userId,
        reason: body.reason ?? null,
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
