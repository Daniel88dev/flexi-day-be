import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { markAttendanceSessionChecked } from "../../services/attendance/attendanceCorrections.js";
import { presentSession, requirePathParam } from "./utils.js";

export const handleMarkAttendanceSessionChecked = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId = requirePathParam(req.params.sessionId, "session id");

  const session = await db.transaction((tx) =>
    markAttendanceSessionChecked(auth.userId, sessionId, tx)
  );

  return res.status(200).json(presentSession(session));
};
