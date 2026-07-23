import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import type { ValidatedPutUserSettingsType } from "../../services/userSettings/types.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

export const handlePutMySettings = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutUserSettingsType = req.body;

  const updated = await services.userSettings.upsertUserSettings(auth.userId, {
    emailNotifications: data.emailNotifications,
  });

  if (!updated) {
    throw new AppError({
      message: "Failed to save settings",
      logging: true,
      code: 500,
      context: { userId: auth.userId, data },
    });
  }

  return res.status(200).json({ emailNotifications: updated.emailNotifications });
};
