import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { DEFAULT_USER_SETTINGS } from "../../services/userSettings/types.js";

const services = createDBServices();

/** The caller's preferences, falling back to the defaults when never changed. */
export const handleGetMySettings = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const settings = await services.userSettings.getUserSettings(auth.userId);

  return res.status(200).json({
    emailNotifications: settings?.emailNotifications ?? DEFAULT_USER_SETTINGS.emailNotifications,
  });
};
