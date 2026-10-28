import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import AppError from "../../utils/appError.js";
import {
  PHOTO_GONE_REASON,
  removePhotoObjects,
  settlePhoto,
} from "../../services/directory/directoryPhotoServices.js";
import { validatePhotoProcessed } from "../../services/directory/types.js";
import { readSignedCallback } from "../attachment/readSignedCallback.js";

/** The `attachment-processor` Lambda's report on a Profile photo, signed like its attachment reports. */
export const handlePhotoProcessed = async (req: Request, res: Response) => {
  const { photoId, ...outcome } = readSignedCallback(req, validatePhotoProcessed, "photo");

  const settled = await db.transaction((tx) => settlePhoto(photoId, outcome, tx));
  if (settled.result === "gone") {
    throw new AppError({
      code: 404,
      message: "Photo not found",
      logging: true,
      context: { photoId },
      publicContext: { reason: PHOTO_GONE_REASON },
    });
  }
  if (settled.result === "already") {
    throw new AppError({
      code: 409,
      message: "Photo has already been processed",
      logging: true,
      context: { photoId, status: settled.photo.status },
      publicContext: { status: settled.photo.status },
    });
  }
  await removePhotoObjects(settled.replaced);
  return res.status(200).json(settled.photo);
};
