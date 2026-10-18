import type { DbTransaction } from "../../db/db.js";
import {
  attendanceClosedBy,
  attendanceEventType,
  attendanceSessionOrigin,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import AppError from "../../utils/appError.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { getEmployment } from "../employment/employmentServices.js";
import { authorizeAttendanceWrite, recordAddedBreak } from "./attendanceCorrections.js";
import {
  appendAttendanceEvent,
  assertNoSessionOverlap,
  getSessionById,
  lockEmployment,
} from "./attendanceServices.js";
import {
  AttendanceCorrectionRight,
  type AttendanceBreakType,
  type AttendanceSessionView,
  type ValidatedAttendanceEntryType,
} from "./types.js";
import {
  sessionCeilingMinutesOf,
  spanMessage,
  spanRefusal,
  spanRefused,
  type SpanRefusal,
} from "./sessionSpan.js";

export type EntryRefusal = SpanRefusal | "OUTSIDE_EMPLOYMENT";

export const entryRefusal = ({
  spell,
  ...span
}: {
  businessDate: DateString;
  startedAt: Date;
  endedAt: Date;
  timezone: string;
  now: Date;
  ceilingMinutes: number;
  spell: { startedAt: Date; endedAt: Date | null };
}): EntryRefusal | null => {
  const refusal = spanRefusal(span);
  if (refusal === "START_OFF_DATE") return refusal;

  const { businessDate, timezone } = span;
  const employedFrom = businessDateInZone(spell.startedAt, timezone);
  const employedTo = spell.endedAt === null ? null : businessDateInZone(spell.endedAt, timezone);
  if (businessDate < employedFrom || (employedTo !== null && businessDate > employedTo)) {
    return "OUTSIDE_EMPLOYMENT";
  }

  return refusal;
};

const entryMessage = (refusal: EntryRefusal, ceilingMinutes: number): string => {
  switch (refusal) {
    case "START_OFF_DATE":
      return "The session has to start on the day it is entered for";
    case "OUTSIDE_EMPLOYMENT":
      return "That day is outside the employment";
    case "START_IN_FUTURE":
    case "END_IN_FUTURE":
      return "An entered session has to have ended already. Still working? Clock in, then correct the start.";
    case "END_BEFORE_START":
    case "OVER_CEILING":
      return spanMessage(refusal, ceilingMinutes);
  }
};

/**
 * Takes the Employment lock a clock-in takes before looking for overlaps, so
 * an entry and a clock-in racing each other cannot both find the minutes free.
 */
export const enterAttendanceSession = async (
  viewerUserId: string,
  input: ValidatedAttendanceEntryType,
  tx: DbTransaction,
  now = new Date()
): Promise<AttendanceSessionView> => {
  const userId = input.userId ?? viewerUserId;
  const employment = await getEmployment(input.organizationId, userId, tx);
  if (!employment) {
    throw new AppError({
      message: "No employment in this organization",
      logging: true,
      code: 404,
      context: { viewerUserId, organizationId: input.organizationId, target: userId },
    });
  }

  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);

  const { right, settings, timezone } = await authorizeAttendanceWrite(
    viewerUserId,
    employment,
    { businessDate: input.businessDate, endedAt },
    tx,
    now
  );

  const ceilingMinutes = sessionCeilingMinutesOf(settings);
  const assertEntryFits = (spell: { startedAt: Date; endedAt: Date | null }) => {
    const refusal = entryRefusal({
      businessDate: input.businessDate,
      startedAt,
      endedAt,
      timezone,
      now,
      ceilingMinutes,
      spell,
    });
    if (refusal) {
      throw spanRefused({
        reason: refusal,
        message: entryMessage(refusal, ceilingMinutes),
        ceilingMinutes,
        context: { viewerUserId, employmentId: employment.id, businessDate: input.businessDate },
      });
    }
  };
  assertEntryFits(employment);

  // A membership change may have ended or restarted the Employment while this
  // waited for the lock, so the owner's right and the spell are decided again on
  // the row as it now stands.
  const locked = await lockEmployment(employment.id, tx);
  if (right === AttendanceCorrectionRight.Self) {
    await authorizeAttendanceWrite(
      viewerUserId,
      locked,
      { businessDate: input.businessDate, endedAt },
      tx,
      now
    );
  }
  assertEntryFits(locked);

  await assertNoSessionOverlap(employment.id, { startedAt, endedAt }, {}, tx);

  const closedBy =
    right === AttendanceCorrectionRight.Admin ? attendanceClosedBy.Admin : attendanceClosedBy.User;
  const id = generateRandomUUID();

  await tx.insert(attendanceSessions).values({
    id,
    employmentId: employment.id,
    businessDate: input.businessDate,
    startedAt,
    endedAt,
    timezone,
    closedBy,
    origin: attendanceSessionOrigin.Entered,
  });

  await appendAttendanceEvent(
    {
      sessionId: id,
      eventType: attendanceEventType.SessionCreated,
      changedByUserId: viewerUserId,
      after: {
        businessDate: input.businessDate,
        startedAt,
        endedAt,
        timezone,
        closedBy,
        origin: attendanceSessionOrigin.Entered,
      },
    },
    tx
  );

  // Checked one by one against the ones already saved, inside the same
  // transaction: a refused break takes the whole entry with it.
  const breaks: AttendanceBreakType[] = [];
  for (const entry of input.breaks ?? []) {
    breaks.push(
      await recordAddedBreak(viewerUserId, { id, startedAt, endedAt }, breaks, entry, tx, {
        sameRequest: true,
      })
    );
  }

  const session = await getSessionById(id, {}, tx);
  if (!session) {
    throw new AppError({
      message: "Failed to enter the session",
      logging: true,
      code: 500,
      context: { sessionId: id },
    });
  }

  return {
    ...session,
    breaks: breaks.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
  };
};
