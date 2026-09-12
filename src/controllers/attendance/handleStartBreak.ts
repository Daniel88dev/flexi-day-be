import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { beginAttendanceWrite, startBreak } from "../../services/attendance/attendanceServices.js";
import { attendanceScopeOfBody, presentBreak } from "./utils.js";

export const handleStartBreak = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const organizationId = attendanceScopeOfBody(req);

  const entry = await db.transaction(async (tx) => {
    const subject = await beginAttendanceWrite(auth.userId, organizationId, tx);
    return startBreak(subject, auth.userId, tx);
  });

  return res.status(201).json(presentBreak(entry));
};
