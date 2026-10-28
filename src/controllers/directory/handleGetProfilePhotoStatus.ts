import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getPhotoUploadStatus } from "../../services/directory/directoryPhotoServices.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetProfilePhotoStatus = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const photoId = requirePathParam(req.params.photoId, "photo id");
  const status = await db.transaction(async (tx) =>
    getPhotoUploadStatus(await directoryViewerFor(req, tx), employmentId, photoId, tx)
  );
  return res.status(200).json(status);
};
