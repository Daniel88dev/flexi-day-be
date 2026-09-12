import { and, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";
import {
  attendanceBreaks,
  attendanceClosedBy,
  attendanceEventType,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  organizationAttendanceSettings,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { appendAttendanceEvent, lockEmployment } from "./attendanceServices.js";

export type AttendanceCeilingSweepResult = {
  sessions: number;
  breaks: number;
};

/**
 * One overdue row, with the instant the sweep will close it at. A computed
 * instant arrives from the driver as a string, so every query below maps it
 * through a timestamp column to come back a `Date`.
 */
type Overdue = {
  id: string;
  employmentId: string;
  closeAt: Date;
};

/** `startedAt` plus a ceiling in minutes, falling back for an organization with no settings row. */
const ceilingEnd = (startedAt: AnyColumn, ceiling: AnyColumn, fallback: number): SQL =>
  sql`${startedAt} + (coalesce(${ceiling}, ${fallback}::int) * interval '1 minute')`;

const sessionCeilingEnd = ceilingEnd(
  attendanceSessions.startedAt,
  organizationAttendanceSettings.sessionCeilingMinutes,
  ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes
);

const breakCeilingEnd = ceilingEnd(
  attendanceBreaks.startedAt,
  organizationAttendanceSettings.breakCeilingMinutes,
  ATTENDANCE_SETTINGS_DEFAULTS.breakCeilingMinutes
);

/**
 * A break never outlives the session holding it, so its close is clamped to
 * where that session would end. Without the clamp a break started in the
 * session's last hour would be closed after the session's own ceiling, and the
 * same tick would then close the session earlier than the break inside it.
 *
 * Only the instant is clamped, never the test for whether the break is overdue:
 * clamping that too would make every break inside an overdue session look past
 * its own ceiling and file an ordinary break as the employee's to correct.
 */
const breakCloseAt: SQL = sql`least(${breakCeilingEnd}, ${sessionCeilingEnd})`;

/**
 * Every session still open past its organization's ceiling. Soft-deleted ones
 * are left alone: the row nobody can read is not a clock anybody forgot.
 *
 * An ended Employment is swept like any other — a dangling open session is
 * exactly the kind the sweep exists for, and the person is not coming back to
 * close it.
 */
const overdueSessions = async (now: Date): Promise<Overdue[]> =>
  db
    .select({
      id: attendanceSessions.id,
      employmentId: attendanceSessions.employmentId,
      closeAt: sql<Date>`${sessionCeilingEnd}`.mapWith(attendanceSessions.startedAt),
    })
    .from(attendanceSessions)
    .innerJoin(employments, eq(employments.id, attendanceSessions.employmentId))
    .leftJoin(
      organizationAttendanceSettings,
      eq(organizationAttendanceSettings.organizationId, employments.organizationId)
    )
    .where(
      and(
        isNull(attendanceSessions.endedAt),
        isNull(attendanceSessions.deletedAt),
        sql`${sessionCeilingEnd} <= ${now}`
      )
    );

const overdueBreaks = async (now: Date): Promise<Overdue[]> =>
  db
    .select({
      id: attendanceBreaks.id,
      employmentId: attendanceSessions.employmentId,
      closeAt: sql<Date>`${breakCloseAt}`.mapWith(attendanceSessions.startedAt),
    })
    .from(attendanceBreaks)
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceBreaks.sessionId))
    .innerJoin(employments, eq(employments.id, attendanceSessions.employmentId))
    .leftJoin(
      organizationAttendanceSettings,
      eq(organizationAttendanceSettings.organizationId, employments.organizationId)
    )
    .where(
      and(
        isNull(attendanceBreaks.endedAt),
        // Only inside a session that is still running. One left open under a
        // closed session is not a break anybody is still on, and closing it
        // here would stamp it auto-closed at an instant its own ceiling never
        // reached.
        isNull(attendanceSessions.endedAt),
        isNull(attendanceSessions.deletedAt),
        sql`${breakCeilingEnd} <= ${now}`
      )
    );

/**
 * Closes one session at `closeAt` under the Employment's own lock — the lock
 * every clock-in, clock-out and break already takes, so a person clocking out
 * this second either gets there first and leaves nothing to do, or waits and
 * finds the sweep has been.
 *
 * An open break goes with it, counted to the same instant the way a clock-out
 * counts one, and recorded on this event rather than getting its own: it is not
 * flagged auto-closed, because that flag means a break that ran past *its*
 * ceiling and the correction dashboard reads it as one.
 */
const closeSession = async (session: Overdue): Promise<boolean> =>
  db.transaction(async (tx) => {
    await lockEmployment(session.employmentId, tx);

    const [open] = await tx
      .select({ id: attendanceSessions.id })
      .from(attendanceSessions)
      .where(and(eq(attendanceSessions.id, session.id), isNull(attendanceSessions.endedAt)));
    if (!open) return false;

    const [openBreak] = await tx
      .select({ id: attendanceBreaks.id, startedAt: attendanceBreaks.startedAt })
      .from(attendanceBreaks)
      .where(and(eq(attendanceBreaks.sessionId, open.id), isNull(attendanceBreaks.endedAt)));

    if (openBreak) {
      // Never before the break began. A break may start on a session that has
      // already run past its ceiling — the sweep closes it on the next tick,
      // not the instant the ceiling passed — and the session still closes where
      // the ceiling is, so such a break collapses to nothing rather than ending
      // before it started.
      const breakEndedAt =
        openBreak.startedAt > session.closeAt ? openBreak.startedAt : session.closeAt;

      await tx
        .update(attendanceBreaks)
        .set({ endedAt: breakEndedAt })
        .where(eq(attendanceBreaks.id, openBreak.id));
    }

    await tx
      .update(attendanceSessions)
      .set({ endedAt: session.closeAt, closedBy: attendanceClosedBy.Sweep })
      .where(eq(attendanceSessions.id, open.id));

    await appendAttendanceEvent(
      {
        sessionId: open.id,
        eventType: attendanceEventType.ClockOut,
        // Null is the sweep, per `docs/attendance.md`.
        changedByUserId: null,
        before: { endedAt: null, closedBy: null },
        after: {
          endedAt: session.closeAt,
          closedBy: attendanceClosedBy.Sweep,
          closedOpenBreakId: openBreak?.id ?? null,
        },
      },
      tx
    );

    return true;
  });

const closeBreak = async (entry: Overdue): Promise<boolean> =>
  db.transaction(async (tx) => {
    await lockEmployment(entry.employmentId, tx);

    const [open] = await tx
      .select({ id: attendanceBreaks.id, sessionId: attendanceBreaks.sessionId })
      .from(attendanceBreaks)
      .where(and(eq(attendanceBreaks.id, entry.id), isNull(attendanceBreaks.endedAt)));
    if (!open) return false;

    await tx
      .update(attendanceBreaks)
      .set({ endedAt: entry.closeAt, autoClosed: true })
      .where(eq(attendanceBreaks.id, open.id));

    await appendAttendanceEvent(
      {
        sessionId: open.sessionId,
        eventType: attendanceEventType.BreakEnd,
        changedByUserId: null,
        before: { breakId: open.id, endedAt: null, autoClosed: false },
        after: { breakId: open.id, endedAt: entry.closeAt, autoClosed: true },
      },
      tx
    );

    return true;
  });

// One row's failure must not end the night's sweep: it stays open for the next
// tick and the rest are closed.
const closeAll = async (
  rows: Overdue[],
  close: (row: Overdue) => Promise<boolean>,
  kind: "session" | "break"
): Promise<number> => {
  let closed = 0;
  for (const row of rows) {
    try {
      if (await close(row)) closed += 1;
    } catch (error) {
      logger.error(`Attendance ceiling sweep could not close a ${kind}`, {
        kind,
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return closed;
};

/**
 * Closes what an employee forgot, at the ceiling rather than at the instant the
 * sweep happened to run: a session left open is closed at `startedAt` plus the
 * organization's session ceiling, a break at its own, and each close appends an
 * event with a null changing user. The next clock-in is not blocked by any of
 * it — the day is closed, and flagged for correction, not held hostage.
 *
 * Breaks go first. A break past its ceiling is the employee's to correct and
 * carries `autoClosed` to say so, whereas one still inside its ceiling when the
 * session ends is simply counted to the clock-out; sweeping breaks first is
 * what keeps those two apart.
 *
 * Idempotent, and safe with another instance running it: every close re-reads
 * its row still open under the Employment's lock, so a second pass finds
 * nothing and reports zero.
 */
export const sweepAttendanceCeilings = async (
  now = new Date()
): Promise<AttendanceCeilingSweepResult> => {
  const breaks = await closeAll(await overdueBreaks(now), closeBreak, "break");
  const sessions = await closeAll(await overdueSessions(now), closeSession, "session");

  return { sessions, breaks };
};
