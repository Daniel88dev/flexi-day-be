import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { softDeleteCalendarSync } from "../../services/calendarSync/calendarSyncServices.js";

const validateUUID = z.uuid();

/** Soft-deletes a config; the feed link stops resolving immediately. */
export const handleDeleteCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const parsedId = validateUUID.safeParse(req.params.id);
  if (!parsedId.success) {
    throw new AppError({ code: 400, message: "Invalid calendar id" });
  }
  const id = parsedId.data;

  const deleted = await softDeleteCalendarSync(id, auth.userId);

  if (!deleted) {
    throw new AppError({
      code: 404,
      message: "Calendar not found",
      context: { userId: auth.userId, id },
    });
  }

  return res.status(200).json({ message: "Calendar deleted" });
};
