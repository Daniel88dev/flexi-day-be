import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import {
  removePhotoObjects,
  removeProfilePhoto,
} from "../../services/directory/directoryPhotoServices.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleDeleteProfilePhoto = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");

  const removed = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return removeProfilePhoto(viewer, employmentId, tx);
  });
  await removePhotoObjects(removed);
  return res.status(204).send();
};
