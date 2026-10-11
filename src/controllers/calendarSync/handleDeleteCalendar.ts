import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import {
  getCalendarSyncById,
  softDeleteCalendarSync,
} from "../../services/calendarSync/calendarSyncServices.js";
import { purgeTarget } from "../../services/calendarSync/syncEngine.js";

const validateUUID = z.uuid();

/**
 * Soft-deletes a config; the feed link stops resolving immediately. A config
 * syncing to a connected account first removes what it wrote there.
 */
export const handleDeleteCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const parsedId = validateUUID.safeParse(req.params.id);
  if (!parsedId.success) {
    throw new AppError({ code: 400, message: "Invalid calendar id" });
  }
  const id = parsedId.data;

  const existing = await getCalendarSyncById(id, auth.userId);
  if (existing?.connectionId) {
    await purgeTarget(id);
  }

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
