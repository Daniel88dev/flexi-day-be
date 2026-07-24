import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedBulkApproveVacationType } from "../../services/vacation/types.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationDecision } from "../../services/vacation/vacationNotifier.js";

const services = createDBServices();

/**
 * Atomically approves many vacation rows. Used by the approvals widget after
 * the FE collapses contiguous day rows into a single approval entry — the FE
 * sends the full `vacationIds` array so a partial failure cannot leave half
 * the range approved.
 */
export const handleBulkApproveVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkApproveVacationType = req.body;
  const uniqueIds = Array.from(new Set(data.ids));

  const approved = await db.transaction(async (tx) => {
    const rows = await services.vacation.getVacationsByIds(uniqueIds, tx);

    if (rows.length !== uniqueIds.length) {
      throw new AppError({
        code: 404,
        message: "One or more vacations not found",
        context: { auth, requested: uniqueIds.length, found: rows.length },
      });
    }

    const distinctGroupIds = Array.from(new Set(rows.map((r) => r.groupId)));
    const allowedGroupIds = new Set(
      await services.group.getGroupsWhereUserCanApprove(distinctGroupIds, auth.userId, tx)
    );

    const unauthorizedGroups = distinctGroupIds.filter((id) => !allowedGroupIds.has(id));
    if (unauthorizedGroups.length > 0) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to approve one or more of these vacations",
        context: { auth, unauthorizedGroups },
      });
    }

    const updated = await services.vacation.approveVacationsBulk(uniqueIds, auth.userId, tx);

    await services.vacationEvent.createVacationEvents(
      updated.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType: vacationEventType.Approved,
        actorUserId: auth.userId,
      })),
      tx
    );

    return updated;
  });

  // Post-commit and best-effort; the notifier logs its own failures. A bulk
  // decision can span several requesters, so it fans out one mail per person.
  await notifyVacationDecision(approved, "approved", { id: auth.userId, name: auth.userName });

  return res.status(200).json({
    message: "Vacations approved",
    approvedCount: approved.length,
  });
};
