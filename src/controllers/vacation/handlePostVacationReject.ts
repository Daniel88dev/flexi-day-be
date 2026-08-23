import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedRejectVacationType } from "../../services/vacation/types.js";
import { assertMayDecide, assertStillPending } from "../../services/vacation/decisionGuards.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationDecision } from "../../services/vacation/vacationNotifier.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handlePostVacationReject = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedRejectVacationType = req.body ?? {};

  const rejected = await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(vacationId, tx);
    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    await assertMayDecide(auth.userId, [vacationData], "reject", tx);
    assertStillPending([vacationData]);
    await assertGroupWritable(vacationData.groupId, tx);

    const row = await services.vacation.rejectVacation(
      vacationId,
      auth.userId,
      body.reason ?? null,
      tx
    );

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
        eventType: vacationEventType.Rejected,
        actorUserId: auth.userId,
        reason: body.reason ?? null,
      },
      tx
    );

    return row;
  });

  // Post-commit and best-effort: the notifier logs its own failures so a mail
  // problem cannot turn a completed rejection into an error for the approver.
  if (rejected) {
    await notifyVacationDecision(
      [rejected],
      "rejected",
      { id: auth.userId, name: auth.userName },
      body.reason ?? null
    );
  }

  return res.status(200).json({ message: "Vacation rejected" });
};
