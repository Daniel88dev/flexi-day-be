import { logger } from "../middleware/logger.js";
import { sweepAttendanceCeilings } from "../services/attendance/attendanceCeilings.js";

/**
 * Runs {@link sweepAttendanceCeilings} on the nightly tick. Safe to call at any
 * time.
 */
export const runAttendanceCeilingSweep = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await sweepAttendanceCeilings(now);

    if (result.sessions + result.breaks === 0) {
      logger.debug("Attendance ceiling sweep: nothing left open");
      return;
    }

    logger.info("Attendance ceiling sweep closed overdue clocks", {
      ...result,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed sweep is recoverable on the next tick.
    logger.error("Attendance ceiling sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
