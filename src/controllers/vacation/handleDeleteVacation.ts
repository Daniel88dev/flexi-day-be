import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedCancelVacationType } from "../../services/vacation/types.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { resolveVacationPermissions } from "./utils.js";

const services = createDBServices();

const validateUUID = z.uuid();

/**
 * Cancels (soft deletes) a request. Owners can withdraw their own bookings —
 * approved ones included — and group admins / approvers can cancel on their
 * behalf. The cancellation is recorded on the timeline so who did it and why
 * survives beyond the row's `deletedAt` stamp.
 */
export const handleDeleteVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedCancelVacationType = req.body ?? {};

  await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(vacationId, tx);

    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    const permissions = await resolveVacationPermissions(auth.userId, vacationData, tx);

    if (!permissions.canCancel) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to cancel this vacation",
        logging: true,
        context: { auth, vacationId },
      });
    }

    const deleted = await services.vacation.deleteVacation(vacationId, tx);
    if (!deleted) {
      throw new AppError({
        code: 500,
        message: "Failed to cancel vacation",
        logging: true,
        context: { auth, vacationId },
      });
    }

    await services.vacationEvent.createVacationEvent(
      {
        id: generateRandomUUID(),
        vacationId,
        eventType: vacationEventType.Cancelled,
        actorUserId: auth.userId,
        reason: body.reason ?? null,
      },
      tx
    );
  });

  return res.status(200).json({ message: "Vacation cancelled" });
};
