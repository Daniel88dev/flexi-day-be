import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { addAttendanceBreak } from "../../services/attendance/attendanceCorrections.js";
import type { ValidatedAttendanceBreakType } from "../../services/attendance/types.js";
import { presentSession, requirePathParam } from "./utils.js";

export const handleAddAttendanceBreak = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId = requirePathParam(req.params.sessionId, "session id");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const input: ValidatedAttendanceBreakType = req.body;

  const session = await db.transaction((tx) =>
    addAttendanceBreak(auth.userId, sessionId, input, tx)
  );

  return res.status(201).json(presentSession(session));
};
