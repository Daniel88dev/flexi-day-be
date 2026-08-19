import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { createDBServices } from "../../services/DBServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import type { ValidatedUpdateVacationType } from "../../services/vacation/types.js";
import type { VacationUpdatePatch } from "../../services/vacation/vacationServices.js";
import { describeVacationChanges } from "../../services/vacation/vacationChangeDetail.js";
import { assertEditWithinQuota } from "../../services/vacation/quotaGuard.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import { resolveGroupAdmin } from "../groupUser/utils.js";
import { notifyVacationUpdated } from "../../services/vacation/vacationNotifier.js";

const services = createDBServices();

/**
 * Admin-only in-place edit of one member's day rows. Only per-day fields are
 * editable; moving a record to another day is a cancel + re-create, so the
 * partial `uniq_vacation_user_day` index never comes into play here. Every row
 * gets an UPDATED timeline event whose reason summarizes what changed.
 */
export const handleUpdateVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedUpdateVacationType = req.body;
  const uniqueIds = Array.from(new Set(data.ids));

  const patch: VacationUpdatePatch = {
    ...(data.vacationType !== undefined && { vacationType: data.vacationType }),
    ...(data.startTime !== undefined && { startTime: data.startTime }),
    ...(data.endTime !== undefined && { endTime: data.endTime }),
    ...(data.halfDay !== undefined && { halfDay: data.halfDay }),
    ...(data.note !== undefined && { note: data.note }),
  };

  const { updated, previous } = await db.transaction(async (tx) => {
    // Excludes soft-deleted rows, so a cancelled id lands in the 404 too — a
    // cancelled record is history and must be re-created, not edited back.
    const rows = await services.vacation.getVacationsByIds(uniqueIds, tx);

    if (rows.length !== uniqueIds.length) {
      throw new AppError({
        code: 404,
        message: "One or more vacations not found",
        context: { auth, requested: uniqueIds.length, found: rows.length },
      });
    }

    // Authorize before inspecting the batch further: the rejected/mixed checks
    // below would otherwise leak record status to callers with no standing.
    for (const groupId of new Set(rows.map((r) => r.groupId))) {
      const { canAdmin } = await resolveGroupAdmin(auth.userId, groupId, tx);
      if (!canAdmin) {
        throw new AppError({
          code: 403,
          message: "You are not allowed to edit records in this group",
          logging: true,
          context: { auth, groupId },
        });
      }
    }

    const rejected = rows.filter((r) => r.rejectedAt !== null);
    if (rejected.length > 0) {
      throw new AppError({
        code: 409,
        message: "Rejected records cannot be edited",
        logging: true,
        context: { auth, rejected: rejected.map((r) => r.id) },
      });
    }

    // One member, one group per call: the edit is a single admin action on a
    // single record run, and the quota guard and events assume as much.
    const userIds = new Set(rows.map((r) => r.userId));
    const groupIds = new Set(rows.map((r) => r.groupId));
    const first = rows[0];
    if (!first || userIds.size > 1 || groupIds.size > 1) {
      throw new AppError({
        code: 422,
        message: "All records must belong to the same member and group",
        logging: true,
        context: { auth, userIds: [...userIds], groupIds: [...groupIds] },
      });
    }

    // The schema's endTime > startTime refine only sees the patch; a one-sided
    // time change must also be checked against each row's stored counterpart
    // or it could persist an inverted range.
    if (patch.startTime !== undefined || patch.endTime !== undefined) {
      const inverted = rows.filter((row) => {
        const start = patch.startTime !== undefined ? patch.startTime : row.startTime;
        const end = patch.endTime !== undefined ? patch.endTime : row.endTime;
        return Boolean(start && end && end <= start);
      });
      if (inverted.length > 0) {
        throw new AppError({
          code: 422,
          message: "`endTime` must be later than `startTime`",
          logging: true,
          context: { auth, inverted: inverted.map((r) => r.id) },
        });
      }
    }

    await assertGroupWritable(first.groupId, tx);

    const weightChanged = rows.some(
      (row) =>
        (patch.vacationType !== undefined && patch.vacationType !== row.vacationType) ||
        (patch.halfDay !== undefined && patch.halfDay !== row.halfDay)
    );
    if (weightChanged) {
      await assertEditWithinQuota(
        rows.map((row) => ({ ...row, ...patch })),
        tx
      );
    }

    const updatedRows = await services.vacation.updateVacationRows(uniqueIds, patch, tx);
    if (updatedRows.length !== uniqueIds.length) {
      // A concurrent cancel or reject won the race for some row.
      throw new AppError({
        code: 409,
        message: "One or more records changed while editing — refresh and retry",
        logging: true,
        context: { auth, requested: uniqueIds.length, updated: updatedRows.length },
      });
    }

    await services.vacationEvent.createVacationEvents(
      rows.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType: vacationEventType.Updated,
        actorUserId: auth.userId,
        reason: describeVacationChanges(row, patch),
      })),
      tx
    );

    return { updated: updatedRows, previous: first };
  });

  // Post-commit and best-effort; the notifier logs its own failures. Editing
  // your own record needs no notice.
  if (previous.userId !== auth.userId) {
    await notifyVacationUpdated(updated, { id: auth.userId, name: auth.userName });
  }

  return res.status(200).json(updated);
};
