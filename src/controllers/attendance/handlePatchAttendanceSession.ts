import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { correctAttendanceSession } from "../../services/attendance/attendanceCorrections.js";
import type { ValidatedAttendanceCorrectionType } from "../../services/attendance/types.js";
import { presentSession, requirePathParam } from "./utils.js";

export const handlePatchAttendanceSession = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId = requirePathParam(req.params.sessionId, "session id");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const patch: ValidatedAttendanceCorrectionType = req.body;

  const session = await db.transaction((tx) =>
    correctAttendanceSession(auth.userId, sessionId, patch, tx)
  );

  return res.status(200).json(presentSession(session));
};
