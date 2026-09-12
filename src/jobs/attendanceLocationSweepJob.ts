import { logger } from "../middleware/logger.js";
import { sweepAttendanceLocations } from "../services/attendance/attendanceRetention.js";

/**
 * Erases attendance coordinates past their twelve months, leaving the sessions
 * themselves standing. Runs on the same nightly tick as the attachment sweep;
 * safe to call at any time.
 */
export const runAttendanceLocationSweep = async (now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await sweepAttendanceLocations(now);

    if (result.sessions + result.events === 0) {
      logger.debug("Attendance location sweep: nothing to erase");
      return;
    }

    logger.info("Attendance location sweep erased coordinates", {
      ...result,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed sweep is recoverable on the next tick.
    logger.error("Attendance location sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
