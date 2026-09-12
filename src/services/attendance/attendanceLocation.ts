import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { attendanceEventType, attendanceSessions } from "../../db/schema/attendance-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import AppError from "../../utils/appError.js";
import { getAttendanceSettings } from "../organization/attendanceSettingsServices.js";
import { appendAttendanceEvent } from "./attendanceServices.js";
import {
  AttendanceSessionEnd,
  LOCATION_WINDOW_MS,
  type AttendanceLocation,
  type AttendanceLocationResult,
  type ValidatedAttendanceLocationType,
} from "./types.js";

/** What the update reads out of the session row, either end. */
type LocatableSession = {
  startedAt: Date;
  endedAt: Date | null;
  startLatitude: number | null;
  startLongitude: number | null;
  startAccuracy: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
  endAccuracy: number | null;
};

/**
 * The one place the two ends differ: which instant the window is measured from,
 * which three columns hold the answer. Everything below reads this rather than
 * branching on the end again.
 */
const ENDS = {
  [AttendanceSessionEnd.In]: {
    anchor: (session: LocatableSession) => session.startedAt,
    read: (session: LocatableSession): AttendanceLocation => ({
      latitude: session.startLatitude,
      longitude: session.startLongitude,
      accuracy: session.startAccuracy,
    }),
    write: (fix: AttendanceLocation) => ({
      startLatitude: fix.latitude,
      startLongitude: fix.longitude,
      startAccuracy: fix.accuracy,
    }),
  },
  [AttendanceSessionEnd.Out]: {
    anchor: (session: LocatableSession) => session.endedAt,
    read: (session: LocatableSession): AttendanceLocation => ({
      latitude: session.endLatitude,
      longitude: session.endLongitude,
      accuracy: session.endAccuracy,
    }),
    write: (fix: AttendanceLocation) => ({
      endLatitude: fix.latitude,
      endLongitude: fix.longitude,
      endAccuracy: fix.accuracy,
    }),
  },
} as const;

/**
 * Whether a fix may be written over what is already there. Both halves are
 * ordinary outcomes rather than errors: the browser answers the low-accuracy
 * request and the high-accuracy one in either order and at either speed, so a
 * late or worse fix is exactly the case this is here to drop.
 */
const supersedes = (fix: { accuracy: number }, stored: AttendanceLocation, elapsedMs: number) => {
  if (elapsedMs < 0 || elapsedMs > LOCATION_WINDOW_MS) return false;
  return stored.accuracy === null || fix.accuracy < stored.accuracy;
};

const notFound = (sessionId: string, userId: string) =>
  new AppError({
    message: "Session not found",
    logging: true,
    code: 404,
    context: { sessionId, userId },
  });

/**
 * Attaches a fix from the browser to one end of a session.
 *
 * Everything that is not an outright refusal answers `applied: false` and
 * leaves the row alone — the window has passed, the accuracy is no better, the
 * organization never switched location on, or the session is still open and so
 * has no clock-out to anchor to. The caller is a `catch`-free fire-and-forget
 * on the frontend, and none of those cases is worth an error there.
 *
 * The row is locked for the length of the transaction because the accuracy
 * rule is a read followed by a write, and the two requests one clock fires can
 * be in flight together.
 */
export const updateSessionLocation = async (
  userId: string,
  sessionId: string,
  fix: ValidatedAttendanceLocationType,
  tx: DbTransaction,
  now = new Date()
): Promise<AttendanceLocationResult> => {
  const [session] = await tx
    .select({
      id: attendanceSessions.id,
      organizationId: employments.organizationId,
      userId: employments.userId,
      startedAt: attendanceSessions.startedAt,
      endedAt: attendanceSessions.endedAt,
      startLatitude: attendanceSessions.startLatitude,
      startLongitude: attendanceSessions.startLongitude,
      startAccuracy: attendanceSessions.startAccuracy,
      endLatitude: attendanceSessions.endLatitude,
      endLongitude: attendanceSessions.endLongitude,
      endAccuracy: attendanceSessions.endAccuracy,
    })
    .from(attendanceSessions)
    .innerJoin(employments, eq(attendanceSessions.employmentId, employments.id))
    .where(and(eq(attendanceSessions.id, sessionId), isNull(attendanceSessions.deletedAt)))
    .for("update", { of: attendanceSessions });

  if (!session) throw notFound(sessionId, userId);

  // Someone else's clock. Not a 404: an admin may hold the id legitimately and
  // still have no business writing a fix onto it.
  if (session.userId !== userId) {
    throw new AppError({
      message: "This session belongs to someone else",
      logging: true,
      code: 403,
      context: { sessionId, userId },
      publicContext: { reason: "NOT_YOUR_SESSION" },
    });
  }

  const end = ENDS[fix.end];
  const anchor = end.anchor(session);
  const stored = end.read(session);
  const unchanged: AttendanceLocationResult = { applied: false, end: fix.end, ...stored };

  // The organization's switch is enforced here as well as in the widget: a
  // client that asks anyway must not get coordinates stored on an Employment
  // that never opted in.
  const settings = await getAttendanceSettings(session.organizationId, tx);
  if (!settings?.locationEnabled) return unchanged;

  if (!anchor) return unchanged;
  if (!supersedes(fix, stored, now.getTime() - anchor.getTime())) return unchanged;

  await tx
    .update(attendanceSessions)
    .set(end.write(fix))
    .where(eq(attendanceSessions.id, session.id));

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.LocationUpdated,
      changedByUserId: userId,
      before: { end: fix.end, ...stored },
      after: {
        end: fix.end,
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
      },
    },
    tx
  );

  return {
    applied: true,
    end: fix.end,
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracy: fix.accuracy,
  };
};
