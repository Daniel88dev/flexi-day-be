import type { Request, Response } from "express";
import { config } from "../../config.js";
import { db } from "../../db/db.js";
import AppError from "../../utils/appError.js";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  verifyAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import {
  PHOTO_GONE_REASON,
  removePhotoObjects,
  settlePhoto,
} from "../../services/directory/directoryPhotoServices.js";
import { validatePhotoProcessed } from "../../services/directory/types.js";

/** The `attachment-processor` Lambda's report on a Profile photo, signed like its attachment reports. */
export const handlePhotoProcessed = async (req: Request, res: Response) => {
  const secret = config.attachments.callbackSecret;
  const body: unknown = req.body;
  const signature = req.header(ATTACHMENT_SIGNATURE_HEADER);
  if (!secret || !Buffer.isBuffer(body) || !verifyAttachmentCallback(secret, body, signature)) {
    throw new AppError({ code: 401, message: "Invalid photo callback signature", logging: true });
  }

  const parsed = validatePhotoProcessed.safeParse(parseJson(body));
  if (!parsed.success) {
    throw new AppError({
      code: 422,
      message: "Malformed photo callback",
      logging: true,
      context: { issues: parsed.error.issues },
    });
  }
  const { photoId, ...outcome } = parsed.data;

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

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};
