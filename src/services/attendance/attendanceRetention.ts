import { and, eq, inArray, isNotNull, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "../../db/db.js";
import {
  attendanceEventType,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { monthsAgoDay, type DateString } from "../../utils/dateFunc.js";
import { LOCATION_RETENTION_MONTHS } from "./types.js";

export type AttendanceLocationSweepResult = {
  /** Sessions whose coordinates were nulled on this pass. */
  sessions: number;
  /** Event payloads the same pass stripped of their coordinates. */
  events: number;
};

/** Every session past retention, as a subquery the event redaction reuses. */
const expiredSessions = (cutoff: DateString) =>
  db
    .select({ id: attendanceSessions.id })
    .from(attendanceSessions)
    .where(lt(attendanceSessions.businessDate, cutoff));

/** `jsonb - key` drops it, leaving `end` and anything a later ticket adds beside it. */
const withoutCoordinates = (column: AnyColumn): SQL =>
  sql`${column} - 'latitude' - 'longitude' - 'accuracy'`;

const stillCarriesCoordinates = (column: AnyColumn): SQL =>
  sql`(${column} ->> 'latitude' is not null or ${column} ->> 'longitude' is not null or ${column} ->> 'accuracy' is not null)`;

/**
 * Nulls the coordinates on every session more than twelve months past its
 * business date, per the retention promise on the privacy page. The session
 * stays: its hours are the record, the coordinates were only ever evidence of
 * where the clock was pressed.
 *
 * **The events go with them.** A `LOCATION_UPDATED` row carries the fix it
 * recorded in `before` and `after`, so clearing only the session columns would
 * leave the coordinates sitting in the audit trail past the date they were
 * promised gone. The rows survive stripped of the three keys — that a fix
 * landed, when, and from whom is the part worth auditing.
 *
 * Soft-deleted sessions are swept too — a row nobody can read is still a row
 * holding coordinates. Two statements rather than the attachment sweep's
 * row-at-a-time loop, because there is no object store to fail alongside them.
 *
 * Both halves re-check that there is anything left to erase, which is what
 * makes the sweep idempotent: a night with nothing new updates nothing and
 * reports zero.
 */
export const sweepAttendanceLocations = async (
  now = new Date()
): Promise<AttendanceLocationSweepResult> => {
  const cutoff = monthsAgoDay(now, LOCATION_RETENTION_MONTHS);

  // Events first. The other statement is what decides whether a session still
  // looks expired, so doing it second cannot strand a payload behind a row
  // that has already been cleared.
  const redacted = await db
    .update(attendanceEvents)
    .set({
      before: withoutCoordinates(attendanceEvents.before),
      after: withoutCoordinates(attendanceEvents.after),
    })
    .where(
      and(
        eq(attendanceEvents.eventType, attendanceEventType.LocationUpdated),
        inArray(attendanceEvents.sessionId, expiredSessions(cutoff)),
        or(
          stillCarriesCoordinates(attendanceEvents.before),
          stillCarriesCoordinates(attendanceEvents.after)
        )
      )
    );

  const cleared = await db
    .update(attendanceSessions)
    .set({
      startLatitude: null,
      startLongitude: null,
      startAccuracy: null,
      endLatitude: null,
      endLongitude: null,
      endAccuracy: null,
    })
    .where(
      and(
        // Strictly older: a business date exactly twelve months back has not
        // yet outlived the promise on the privacy page.
        lt(attendanceSessions.businessDate, cutoff),
        or(
          isNotNull(attendanceSessions.startLatitude),
          isNotNull(attendanceSessions.startLongitude),
          isNotNull(attendanceSessions.startAccuracy),
          isNotNull(attendanceSessions.endLatitude),
          isNotNull(attendanceSessions.endLongitude),
          isNotNull(attendanceSessions.endAccuracy)
        )
      )
    );

  return { sessions: cleared.rowCount ?? 0, events: redacted.rowCount ?? 0 };
};
