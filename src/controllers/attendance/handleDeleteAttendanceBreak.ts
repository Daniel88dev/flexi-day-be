import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { deleteAttendanceBreak } from "../../services/attendance/attendanceCorrections.js";
import { presentSession, requirePathParam } from "./utils.js";

export const handleDeleteAttendanceBreak = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const breakId = requirePathParam(req.params.breakId, "break id");

  const session = await db.transaction((tx) => deleteAttendanceBreak(auth.userId, breakId, tx));

  return res.status(200).json(presentSession(session));
};
