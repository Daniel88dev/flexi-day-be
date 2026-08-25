import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { DEFAULT_USER_SETTINGS } from "../../services/userSettings/types.js";
import { getUserSettings } from "../../services/userSettings/userSettingsServices.js";

/** The caller's preferences, falling back to the defaults when never changed. */
export const handleGetMySettings = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const settings = await getUserSettings(auth.userId);

  return res.status(200).json({
    emailNotifications: settings?.emailNotifications ?? DEFAULT_USER_SETTINGS.emailNotifications,
    dashboardScope: settings?.dashboardScope ?? DEFAULT_USER_SETTINGS.dashboardScope,
    dashboardGroupId: settings?.dashboardGroupId ?? DEFAULT_USER_SETTINGS.dashboardGroupId,
  });
};
