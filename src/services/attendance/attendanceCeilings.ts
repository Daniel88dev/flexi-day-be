import { logger } from "../../middleware/logger.js";
import {
  closeBreak,
  closeSession,
  overdueBreaks,
  overdueSessions,
  type Overdue,
} from "./attendanceCeilingCloses.js";
import { notifySessionAutoClosed } from "./attendanceNotifier.js";

export type AttendanceCeilingSweepResult = {
  sessions: number;
  breaks: number;
};

// One row's failure must not end the night's sweep: it stays open for the next
// tick and the rest are closed.
const closeAll = async <Row extends Overdue>(
  rows: Row[],
  close: (row: Row) => Promise<boolean>,
  kind: "session" | "break"
): Promise<Row[]> => {
  const closed: Row[] = [];
  for (const row of rows) {
    try {
      if (await close(row)) closed.push(row);
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

  for (const session of sessions) {
    await notifySessionAutoClosed(session);
  }

  return { sessions: sessions.length, breaks: breaks.length };
};
