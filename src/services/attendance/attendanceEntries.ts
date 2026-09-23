import type { DbTransaction } from "../../db/db.js";
import {
  attendanceClosedBy,
  attendanceEventType,
  attendanceSessionOrigin,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
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

export type EntryRefusal =
  "START_OFF_DATE" | "OUTSIDE_EMPLOYMENT" | "END_BEFORE_START" | "END_IN_FUTURE" | "OVER_CEILING";

export const entryRefusal = ({
  businessDate,
  startedAt,
  endedAt,
  timezone,
  now,
  ceilingMinutes,
  spell,
}: {
  businessDate: DateString;
  startedAt: Date;
  endedAt: Date;
  timezone: string;
  now: Date;
  ceilingMinutes: number;
  spell: { startedAt: Date; endedAt: Date | null };
}): EntryRefusal | null => {
  if (businessDateInZone(startedAt, timezone) !== businessDate) return "START_OFF_DATE";

  const employedFrom = businessDateInZone(spell.startedAt, timezone);
  const employedTo = spell.endedAt === null ? null : businessDateInZone(spell.endedAt, timezone);
  if (businessDate < employedFrom || (employedTo !== null && businessDate > employedTo)) {
    return "OUTSIDE_EMPLOYMENT";
  }

  if (endedAt <= startedAt) return "END_BEFORE_START";
  if (endedAt > now) return "END_IN_FUTURE";
  if (endedAt.getTime() - startedAt.getTime() > ceilingMinutes * 60_000) return "OVER_CEILING";

  return null;
};

const hoursAndMinutes = (minutes: number): string =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

const entryMessage = (refusal: EntryRefusal, ceilingMinutes: number): string => {
  switch (refusal) {
    case "START_OFF_DATE":
      return "The session has to start on the day it is entered for";
    case "OUTSIDE_EMPLOYMENT":
      return "That day is outside the employment";
    case "END_BEFORE_START":
      return "A session has to end after it starts";
    case "END_IN_FUTURE":
      return "An entered session has to have ended already. Still working? Clock in, then correct the start.";
    case "OVER_CEILING":
      return `A session can't be longer than ${hoursAndMinutes(ceilingMinutes)}, the organization's session limit`;
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

  const ceilingMinutes =
    settings?.sessionCeilingMinutes ?? ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes;
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
      throw new AppError({
        message: entryMessage(refusal, ceilingMinutes),
        logging: true,
        code: 422,
        context: { viewerUserId, employmentId: employment.id, businessDate: input.businessDate },
        publicContext: {
          reason: refusal,
          ...(refusal === "OVER_CEILING" ? { ceilingMinutes } : {}),
        },
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
