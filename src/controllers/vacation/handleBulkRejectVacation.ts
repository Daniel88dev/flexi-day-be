import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedBulkRejectVacationType } from "../../services/vacation/types.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationDecision } from "../../services/vacation/vacationNotifier.js";
import { assertMayDecide, assertStillPending } from "./decisionGuards.js";
import { assertGroupsWritable } from "../../services/billing/guards.js";

const services = createDBServices();

export const handleBulkRejectVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkRejectVacationType = req.body;
  const uniqueIds = Array.from(new Set(data.ids));

  const rejected = await db.transaction(async (tx) => {
    const rows = await services.vacation.getVacationsByIds(uniqueIds, tx);

    if (rows.length !== uniqueIds.length) {
      throw new AppError({
        code: 404,
        message: "One or more vacations not found",
        context: { auth, requested: uniqueIds.length, found: rows.length },
      });
    }

    await assertMayDecide(auth.userId, rows, "reject", tx);
    assertStillPending(rows);
    await assertGroupsWritable(
      rows.map((row) => row.groupId),
      tx
    );

    const updated = await services.vacation.rejectVacationsBulk(
      uniqueIds,
      auth.userId,
      data.reason ?? null,
      tx
    );

    // A short update means a concurrent decision took part of the batch.
    if (updated.length !== uniqueIds.length) {
      throw new AppError({
        code: 409,
        message: "One or more of these requests has already been decided",
        logging: true,
        context: { auth, requested: uniqueIds, updated: updated.map((row) => row.id) },
      });
    }

    await services.vacationEvent.createVacationEvents(
      updated.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType: vacationEventType.Rejected,
        actorUserId: auth.userId,
        reason: data.reason ?? null,
      })),
      tx
    );

    return updated;
  });

  // Post-commit and best-effort; the notifier logs its own failures. A bulk
  // decision can span several requesters, so it fans out one mail per person.
  await notifyVacationDecision(
    rejected,
    "rejected",
    { id: auth.userId, name: auth.userName },
    data.reason ?? null
  );

  return res.status(200).json({
    message: "Vacations rejected",
    rejectedCount: rejected.length,
  });
};
