import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { updateRetentionPeriod } from "../../services/directory/retentionSettingsServices.js";
import type { PutRetentionPeriod } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePutRetentionPeriod = async (req: Request, res: Response) => {
  const body = req.body as PutRetentionPeriod;
  const settings = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return updateRetentionPeriod(viewer, body, tx);
  });
  return res.status(200).json(settings);
};
