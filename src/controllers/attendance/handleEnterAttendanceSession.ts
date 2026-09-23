import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { enterAttendanceSession } from "../../services/attendance/attendanceEntries.js";
import type { ValidatedAttendanceEntryType } from "../../services/attendance/types.js";
import { presentSession } from "./utils.js";

export const handleEnterAttendanceSession = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const entry: ValidatedAttendanceEntryType = req.body;

  const session = await db.transaction((tx) => enterAttendanceSession(auth.userId, entry, tx));

  return res.status(201).json(presentSession(session));
};
