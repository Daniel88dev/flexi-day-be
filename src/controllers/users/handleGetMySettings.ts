import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { DEFAULT_USER_SETTINGS } from "../../services/userSettings/types.js";
import { toUserSettingsResponse } from "../../services/userSettings/userSettingsResponse.js";
import { getUserSettings } from "../../services/userSettings/userSettingsServices.js";

/** The caller's preferences, falling back to the defaults when never changed. */
export const handleGetMySettings = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const settings = await getUserSettings(auth.userId);

  return res.status(200).json(toUserSettingsResponse(settings ?? DEFAULT_USER_SETTINGS));
};
