import type { Request, Response } from "express";
import { getPhotoUploadStatus } from "../../services/directory/directoryPhotoServices.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetProfilePhotoStatus = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  const status = await getPhotoUploadStatus(
    viewer,
    requirePathParam(req.params.employmentId, "employment id"),
    requirePathParam(req.params.photoId, "photo id")
  );
  return res.status(200).json(status);
};
