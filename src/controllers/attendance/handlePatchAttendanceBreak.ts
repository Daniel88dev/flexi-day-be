import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { correctAttendanceBreak } from "../../services/attendance/attendanceCorrections.js";
import type { ValidatedAttendanceCorrectionType } from "../../services/attendance/types.js";
import { presentSession, requirePathParam } from "./utils.js";

/** Answers with the whole session: the day's figures moved with the break. */
export const handlePatchAttendanceBreak = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const breakId = requirePathParam(req.params.breakId, "break id");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const patch: ValidatedAttendanceCorrectionType = req.body;

  const session = await db.transaction((tx) =>
    correctAttendanceBreak(auth.userId, breakId, patch, tx)
  );

  return res.status(200).json(presentSession(session));
};
