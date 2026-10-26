import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import {
  removePhotoObjects,
  removeProfilePhoto,
} from "../../services/directory/directoryPhotoServices.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import { requirePathParam } from "../attendance/utils.js";

export const handleDeleteProfilePhoto = async (req: Request, res: Response) => {
  const organizationId = requirePathParam(req.params.organizationId, "organization id");
  const employmentId = requirePathParam(req.params.employmentId, "employment id");

  const removed = await db.transaction(async (tx) => {
    const viewer = await loadDirectoryViewer(getAuth(req).userId, organizationId, tx);
    return removeProfilePhoto(viewer, employmentId, tx);
  });
  await removePhotoObjects(removed);
  return res.status(204).send();
};
