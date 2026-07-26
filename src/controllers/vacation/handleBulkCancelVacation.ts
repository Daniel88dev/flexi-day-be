import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedBulkCancelVacationType } from "../../services/vacation/types.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationsCancelled } from "../../services/vacation/vacationNotifier.js";

const services = createDBServices();

/**
 * Atomically cancels (soft deletes) many vacation rows. The detail view sends
 * every day id of a multi-day request so the whole range is cancelled together
 * or not at all. Unlike bulk approve/reject, an owner may cancel their own
 * days, so authorization allows owner, group admin, or approver per row.
 */
export const handleBulkCancelVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkCancelVacationType = req.body;
  const uniqueIds = Array.from(new Set(data.ids));

  const cancelled = await db.transaction(async (tx) => {
    const rows = await services.vacation.getVacationsByIds(uniqueIds, tx);

    if (rows.length !== uniqueIds.length) {
      throw new AppError({
        code: 404,
        message: "One or more vacations not found",
        context: { auth, requested: uniqueIds.length, found: rows.length },
      });
    }

    const distinctGroupIds = Array.from(new Set(rows.map((r) => r.groupId)));
    const approvableGroups = new Set(
      await services.group.getGroupsWhereUserCanApprove(distinctGroupIds, auth.userId, tx)
    );
    const adminGroups = new Set<string>();
    for (const groupId of distinctGroupIds) {
      const membership = await services.groupUser.getGroupUser(auth.userId, groupId, tx);
      if (membership?.adminAccess) adminGroups.add(groupId);
    }

    const unauthorized = rows.filter(
      (r) =>
        r.userId !== auth.userId && !approvableGroups.has(r.groupId) && !adminGroups.has(r.groupId)
    );
    if (unauthorized.length > 0) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to cancel one or more of these vacations",
        logging: true,
        context: { auth, unauthorized: unauthorized.map((r) => r.id) },
      });
    }

    const updated = await services.vacation.cancelVacationsBulk(uniqueIds, tx);

    await services.vacationEvent.createVacationEvents(
      updated.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType: vacationEventType.Cancelled,
        actorUserId: auth.userId,
        reason: data.reason ?? null,
      })),
      tx
    );

    // The pre-cancellation rows still carry `approvedAt`, which the notifier
    // needs to decide whether a cancellation is worth an email.
    return rows;
  });

  // Post-commit and best-effort; the notifier logs its own failures.
  await notifyVacationsCancelled(
    cancelled,
    { id: auth.userId, name: auth.userName },
    data.reason ?? null
  );

  return res.status(200).json({
    message: "Vacations cancelled",
    cancelledCount: cancelled.length,
  });
};
