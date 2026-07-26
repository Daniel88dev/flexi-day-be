import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPostVacationType } from "../../services/vacation/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import {
  expandDateRangeInclusive,
  filterWorkingDays,
  formatDateToISOString,
} from "../../utils/dateFunc.js";
import { createDBServices } from "../../services/DBServices.js";
import { db } from "../../db/db.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationRequested } from "../../services/vacation/vacationNotifier.js";

const services = createDBServices();

// One full year. Caps the per-day fan-out so a pathological `from`/`to` pair
// can't allocate tens of thousands of rows or stall a bulk insert.
const MAX_VACATION_RANGE_DAYS = 366;

export const handlePostVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostVacationType = req.body;

  const fromIso = formatDateToISOString(data.from);
  const toIso = formatDateToISOString(data.to);

  if (toIso < fromIso) {
    throw new AppError({
      message: "`to` must be greater than or equal to `from`",
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso },
    });
  }

  const rangeDays =
    Math.round((data.to.getTime() - data.from.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (rangeDays > MAX_VACATION_RANGE_DAYS) {
    throw new AppError({
      message: `Vacation range too large (max ${MAX_VACATION_RANGE_DAYS.toString()} days)`,
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso, rangeDays },
    });
  }

  const access = await services.groupUser.getGroupUser(auth.userId, data.groupId);

  if (!access || !access.controlledUser) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
    });
  }

  const group = await services.group.getGroup(data.groupId);

  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId: data.groupId },
    });
  }

  const days = expandDateRangeInclusive(fromIso, toIso);

  if (days.length === 0) {
    throw new AppError({
      message: "Invalid date range",
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso },
    });
  }

  // Non-working days inside a range are dropped; an all-non-working request is rejected below.
  const workingDays = filterWorkingDays(days, group.workingDays);

  if (workingDays.length === 0) {
    throw new AppError({
      message:
        days.length === 1
          ? "Selected day is not a working day"
          : "Selected range contains no working days",
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso, groupWorkingDays: group.workingDays },
    });
  }

  const records = workingDays.map((day) => ({
    id: generateRandomUUID(),
    userId: auth.userId,
    groupId: data.groupId,
    requestedDay: day,
    startTime: data.startTime,
    endTime: data.endTime,
    vacationType: data.vacationType,
    halfDay: data.halfDay,
    note: data.note,
  }));

  const created = await db.transaction(async (tx) => {
    const rows = await services.vacation.postVacationBulk(records, tx);
    await services.vacationEvent.createVacationEvents(
      rows.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType: vacationEventType.Created,
        actorUserId: auth.userId,
      })),
      tx
    );
    return rows;
  });

  if (created.length === 0) {
    throw new AppError({
      message: "Failed to create vacation",
      logging: true,
      code: 500,
      context: { userId: auth.userId, from: fromIso, to: toIso },
    });
  }

  // Best-effort notification. The rows above are already committed, so any
  // failure here must NOT bubble up: a 5xx would tempt the client to retry a
  // non-idempotent endpoint (the insert uses onConflictDoNothing, so the retry
  // would return an empty set and our "no rows created" guard would mislead
  // the caller into thinking nothing was booked). notifyVacationRequested
  // swallows and logs its own errors.
  await notifyVacationRequested(
    created,
    { id: auth.userId, name: auth.userName },
    data.note ?? null
  );

  return res.status(201).json(created);
};
