import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { beginAttendanceWrite, endBreak } from "../../services/attendance/attendanceServices.js";
import { attendanceScopeOfBody, presentBreak } from "./utils.js";

export const handleEndBreak = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const organizationId = attendanceScopeOfBody(req);

  const entry = await db.transaction(async (tx) => {
    const subject = await beginAttendanceWrite(auth.userId, organizationId, tx);
    return endBreak(subject, auth.userId, tx);
  });

  return res.status(200).json(presentBreak(entry));
};
