import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { feedBaseUrl, serializeConfig } from "./utils.js";
import { getCalendarSyncById } from "../../services/calendarSync/calendarSyncServices.js";

const validateUUID = z.uuid();

/** Returns a single config owned by the caller, with its full feed URL. */
export const handleGetCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const id = validateUUID.parse(req.params.id);

  const config = await getCalendarSyncById(id, auth.userId);

  if (!config) {
    throw new AppError({
      code: 404,
      message: "Calendar not found",
      context: { auth, id },
    });
  }

  return res.status(200).json(serializeConfig(config, feedBaseUrl(req), true));
};
