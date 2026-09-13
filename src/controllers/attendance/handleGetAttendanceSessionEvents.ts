import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { listAttendanceSessionEvents } from "../../services/attendance/attendanceCorrections.js";
import { presentAttendanceEvent, requirePathParam } from "./utils.js";

export const handleGetAttendanceSessionEvents = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId = requirePathParam(req.params.sessionId, "session id");

  const events = await listAttendanceSessionEvents(auth.userId, sessionId);

  return res.status(200).json({ sessionId, events: events.map(presentAttendanceEvent) });
};
