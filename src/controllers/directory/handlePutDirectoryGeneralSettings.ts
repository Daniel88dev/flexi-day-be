import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { updateGeneralSettings } from "../../services/directory/generalSettingsServices.js";
import type { PutDirectoryGeneralSettings } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePutDirectoryGeneralSettings = async (req: Request, res: Response) => {
  const body = req.body as PutDirectoryGeneralSettings;
  const settings = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return updateGeneralSettings(viewer, body, tx);
  });
  return res.status(200).json(settings);
};
