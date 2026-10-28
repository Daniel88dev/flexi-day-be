import type { Request, Response } from "express";
import { readGeneralSettings } from "../../services/directory/generalSettingsServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetDirectoryGeneralSettings = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await readGeneralSettings(viewer));
};
