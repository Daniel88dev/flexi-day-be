import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

const validateUUID = z.uuid();

/** Soft-deletes a config; the feed link stops resolving immediately. */
export const handleDeleteCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const parsedId = validateUUID.safeParse(req.params.id);
  if (!parsedId.success) {
    throw new AppError({ code: 400, message: "Invalid calendar id" });
  }
  const id = parsedId.data;

  const deleted = await services.calendarSync.softDeleteCalendarSync(
    id,
    auth.userId
  );

  if (!deleted) {
    throw new AppError({
      code: 404,
      message: "Calendar not found",
      context: { userId: auth.userId, id },
    });
  }

  return res.status(200).json({ message: "Calendar deleted" });
};
