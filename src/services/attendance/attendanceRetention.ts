import { and, isNotNull, lt, or } from "drizzle-orm";
import { db } from "../../db/db.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import { monthsAgoDay } from "../../utils/dateFunc.js";
import { LOCATION_RETENTION_MONTHS } from "./types.js";

export type AttendanceLocationSweepResult = {
  /** Sessions whose coordinates were nulled on this pass. */
  sessions: number;
};

/**
 * Nulls the coordinates on every session more than twelve months past its
 * business date, per the retention promise on the privacy page. The session
 * stays: its hours are the record, the coordinates were only ever evidence of
 * where the clock was pressed.
 *
 * Soft-deleted sessions are swept too — a row nobody can read is still a row
 * holding coordinates. One statement rather than the attachment sweep's
 * row-at-a-time loop, because there is no object store to fail alongside it.
 *
 * `isNotNull` on the six columns is what makes the sweep idempotent: a night
 * with nothing new to erase updates nothing and reports zero.
 */
export const sweepAttendanceLocations = async (
  now = new Date()
): Promise<AttendanceLocationSweepResult> => {
  const rows = await db
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
        lt(attendanceSessions.businessDate, monthsAgoDay(now, LOCATION_RETENTION_MONTHS)),
        or(
          isNotNull(attendanceSessions.startLatitude),
          isNotNull(attendanceSessions.startLongitude),
          isNotNull(attendanceSessions.startAccuracy),
          isNotNull(attendanceSessions.endLatitude),
          isNotNull(attendanceSessions.endLongitude),
          isNotNull(attendanceSessions.endAccuracy)
        )
      )
    )
    .returning({ id: attendanceSessions.id });

  return { sessions: rows.length };
};
