import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { requestPhotoUpload } from "../../services/directory/directoryPhotoServices.js";
import type { PostProfilePhoto } from "../../services/directory/types.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostProfilePhoto = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const body = req.body as PostProfilePhoto;

  const started = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return requestPhotoUpload(viewer, employmentId, body, tx);
  });
  return res.status(201).json(started);
};
