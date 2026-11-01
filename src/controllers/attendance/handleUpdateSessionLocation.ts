import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { updateSessionLocation } from "../../services/attendance/attendanceLocation.js";
import type { ValidatedAttendanceLocationType } from "../../services/attendance/types.js";
import { requirePathParam } from "../pathParams.js";

/**
 * Attaches a fix from the browser to one end of the caller's own session. A
 * fix that arrived too late, or no more accurate than the one already stored,
 * answers `applied: false` rather than an error — the client fires two of them
 * per clock and swallows whatever comes back.
 */
export const handleUpdateSessionLocation = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId = requirePathParam(req.params.sessionId, "session id");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const fix: ValidatedAttendanceLocationType = req.body;

  const result = await db.transaction((tx) =>
    updateSessionLocation(auth.userId, sessionId, fix, tx)
  );

  return res.status(200).json(result);
};
