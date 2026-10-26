import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { previewRetentionPeriod } from "../../services/directory/retentionSettingsServices.js";
import { validateRetentionPreviewQuery } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetRetentionPreview = async (req: Request, res: Response) => {
  const query = validateRetentionPreviewQuery.safeParse(req.query);
  if (!query.success) {
    throw new AppError({ code: 422, message: "Invalid retention preview query", logging: false });
  }
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await previewRetentionPeriod(viewer, query.data));
};
