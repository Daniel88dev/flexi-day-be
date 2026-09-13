import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAttendanceMonth } from "../../services/attendance/attendanceServices.js";
import { validateAttendanceMonthQuery } from "../../services/attendance/types.js";
import AppError from "../../utils/appError.js";
import { presentAttendanceMonth } from "./utils.js";

/**
 * One month of the caller's own attendance, and nobody else's: an admin reads
 * somebody else's through the team dashboard, which carries the visibility
 * matrix. Naming another `userId` is refused rather than ignored, so a caller
 * is never shown their own month believing it is a colleague's.
 */
export const handleGetAttendanceMonth = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { userId, ...query } = validateAttendanceMonthQuery.parse(req.query);

  if (userId !== undefined && userId !== auth.userId) {
    throw new AppError({
      message: "This month is only your own",
      logging: true,
      code: 403,
      context: { userId: auth.userId, target: userId },
      publicContext: { reason: "OWN_EMPLOYMENT_ONLY" },
    });
  }

  const month = await getAttendanceMonth(auth.userId, query);

  return res.status(200).json(presentAttendanceMonth(month));
};
