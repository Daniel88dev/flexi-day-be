import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";
import { feedBaseUrl, serializeConfig } from "./utils.js";

const services = createDBServices();

const validateUUID = z.uuid();

/** Rotates the feed token, revoking the previous subscription link. */
export const handleRegenerateToken = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const id = validateUUID.parse(req.params.id);

  const config = await services.calendarSync.regenerateToken(
    id,
    auth.userId,
    services.calendarSync.generateFeedToken()
  );

  if (!config) {
    throw new AppError({
      code: 404,
      message: "Calendar not found",
      context: { auth, id },
    });
  }

  return res.status(200).json(serializeConfig(config, feedBaseUrl(req), true));
};
