import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { requestPhotoUpload } from "../../services/directory/directoryPhotoServices.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import type { PostProfilePhoto } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";

export const handlePostProfilePhoto = async (req: Request, res: Response) => {
  const organizationId = requirePathParam(req.params.organizationId, "organization id");
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const body = req.body as PostProfilePhoto;

  const started = await db.transaction(async (tx) => {
    const viewer = await loadDirectoryViewer(getAuth(req).userId, organizationId, tx);
    return requestPhotoUpload(viewer, employmentId, body, tx);
  });
  return res.status(201).json(started);
};
