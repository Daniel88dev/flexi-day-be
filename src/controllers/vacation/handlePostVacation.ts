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
import { db } from "../../db/db.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import {
  notifyVacationBookedOnBehalf,
  notifyVacationDecision,
  notifyVacationRequested,
} from "../../services/vacation/vacationNotifier.js";
import { assertRequestWithinQuota } from "../../services/vacation/quotaGuard.js";
import { assertGroupWritable, assertSickDayRequestable } from "../../services/billing/guards.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import { getGroup } from "../../services/group/groupServices.js";
import { getGroupUser } from "../../services/groupUser/groupUserServices.js";
import { getUserById } from "../../services/user/userServices.js";
import { postVacationBulk } from "../../services/vacation/vacationServices.js";
import { createVacationEvents } from "../../services/vacationEvent/vacationEventServices.js";

// One full year. Caps the per-day fan-out so a pathological `from`/`to` pair
// can't allocate tens of thousands of rows or stall a bulk insert.
const MAX_VACATION_RANGE_DAYS = 366;

// Retroactive entries are legitimate (sick leave is reported after the fact)
// but only back to the start of this year.
const earliestBookableDay = (today: Date): string => `${today.getUTCFullYear().toString()}-01-01`;
const latestBookableDay = (today: Date): string =>
  `${(today.getUTCFullYear() + 1).toString()}-12-31`;

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

  const today = new Date();
  const earliest = earliestBookableDay(today);
  const latest = latestBookableDay(today);
  if (fromIso < earliest || toIso > latest) {
    throw new AppError({
      message: `Leave can only be booked between ${earliest} and ${latest}`,
      logging: true,
      code: 422,
      context: { from: fromIso, to: toIso, earliest, latest },
      publicContext: { earliest, latest },
    });
  }

  const targetUserId = data.userId ?? auth.userId;
  const onBehalf = targetUserId !== auth.userId;

  if (onBehalf) {
    // Group admins and org admins may book for a member; the booking itself is
    // still gated on the member's own `controlledUser` membership below.
    await assertGroupAdmin(auth.userId, data.groupId);
  } else if (data.autoApprove) {
    // Self-booking keeps the normal flow — whether an admin may wave their own
    // request through is governed by the approval rules (`mayDecideOwn`), not
    // by this shortcut.
    throw new AppError({
      message: "`autoApprove` is only valid when booking on behalf of a member",
      logging: true,
      code: 422,
    });
  }

  const access = await getGroupUser(targetUserId, data.groupId);

  if (!access || !access.controlledUser) {
    throw new AppError({
      message: onBehalf
        ? "That member cannot book leave in this group"
        : "No access for related group",
      logging: true,
      code: 403,
      context: { targetUserId, groupId: data.groupId },
    });
  }

  const group = await getGroup(data.groupId);

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

  const approvalStamp = data.autoApprove ? { approvedAt: new Date(), approvedBy: auth.userId } : {};

  const records = workingDays.map((day) => ({
    id: generateRandomUUID(),
    userId: targetUserId,
    groupId: data.groupId,
    requestedDay: day,
    startTime: data.startTime,
    endTime: data.endTime,
    vacationType: data.vacationType,
    halfDay: data.halfDay,
    note: data.note,
    createdByUserId: auth.userId,
    ...approvalStamp,
  }));

  const created = await db.transaction(async (tx) => {
    // Inside the write transaction, not before it: a downgrade committing
    // between the check and the insert would otherwise let this request write
    // into a group that has just become read-only.
    await assertGroupWritable(data.groupId, tx);

    // Same timing for the Sick day benefit: dormancy is derived from the live
    // subscription, so it too is asserted on the tx snapshot.
    if (data.vacationType === CalendarRecordType.SickDay) {
      await assertSickDayRequestable(data.groupId, tx);
    }

    if (onBehalf) {
      // Same reasoning for delegated authority: the pre-transaction checks
      // fail fast for the client, but a revocation committing in between must
      // still abort the write, so both are re-asserted on the tx snapshot.
      await assertGroupAdmin(auth.userId, data.groupId, tx);
      const liveAccess = await getGroupUser(targetUserId, data.groupId, tx);
      if (!liveAccess?.controlledUser) {
        throw new AppError({
          message: "That member cannot book leave in this group",
          logging: true,
          code: 403,
          context: { targetUserId, groupId: data.groupId },
        });
      }
    }

    await assertRequestWithinQuota(records, tx);

    const rows = await postVacationBulk(records, tx);
    await createVacationEvents(
      rows.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType: vacationEventType.Created,
        actorUserId: auth.userId,
      })),
      tx
    );
    if (data.autoApprove) {
      // A separate APPROVED event so the timeline reads like the normal flow:
      // the admin both created and approved the record.
      await createVacationEvents(
        rows.map((row) => ({
          id: generateRandomUUID(),
          vacationId: row.id,
          eventType: vacationEventType.Approved,
          actorUserId: auth.userId,
        })),
        tx
      );
    }
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

  // Best-effort notifications. The rows above are already committed, so any
  // failure here must NOT bubble up: a 5xx would tempt the client to retry a
  // non-idempotent endpoint (the insert uses onConflictDoNothing, so the retry
  // would return an empty set and our "no rows created" guard would mislead
  // the caller into thinking nothing was booked). The notifiers swallow and
  // log their own errors.
  const actor = { id: auth.userId, name: auth.userName };
  if (data.autoApprove) {
    // Nothing left to decide, so approvers are not asked; the member hears the
    // record was booked and approved for them.
    await notifyVacationDecision(created, "approved", actor);
  } else if (onBehalf) {
    // Approvers must see the member as the requester — the leave is theirs;
    // the admin who filed it is attributed on the timeline and in the member's
    // own notice, and must not displace the member in the approver mail.
    const member = await getUserById(targetUserId).catch(() => undefined);
    if (member) {
      await notifyVacationRequested(
        created,
        { id: member.id, name: member.name },
        data.note ?? null
      );
    }
    // No fallback to the admin: a mail naming the wrong requester is worse
    // than no mail — the request still sits in every approver's queue.
    await notifyVacationBookedOnBehalf(created, actor);
  } else {
    await notifyVacationRequested(created, actor, data.note ?? null);
  }

  return res.status(201).json(created);
};
