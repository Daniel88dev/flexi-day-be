import type { Request, Response } from "express";
import { readRetentionSettings } from "../../services/directory/retentionSettingsServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetRetentionSettings = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await readRetentionSettings(viewer));
};
