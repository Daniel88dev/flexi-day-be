import type { Request, Response } from "express";
import { z } from "zod";
import { completeLocalPhotoUpload } from "../../services/directory/directoryPhotoServices.js";
import { verifyLocalPhotoUpload } from "../../services/organizationData/organizationDataStore.js";
import AppError from "../../utils/appError.js";
import { requirePathParam } from "../attendance/utils.js";

const signedQuery = z.object({
  expires: z.coerce.number().int(),
  signature: z.string().min(1),
});

/** The disk store's stand-in for the presigned photo POST; the signed URL is the credential. */
export const handleLocalPhotoUpload = async (req: Request, res: Response) => {
  const photoId = requirePathParam(req.params.photoId, "photo id");
  const parsed = signedQuery.safeParse(req.query);
  if (
    !parsed.success ||
    !verifyLocalPhotoUpload({ photoId, expires: parsed.data.expires }, parsed.data.signature)
  ) {
    throw new AppError({ code: 403, message: "Invalid or expired link", logging: false });
  }

  const bytes: unknown = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new AppError({ code: 422, message: "Upload body is empty", logging: true });
  }

  const settled = await completeLocalPhotoUpload(photoId, bytes);
  if (!settled) {
    throw new AppError({
      code: 409,
      message: "This photo upload is no longer waiting for bytes",
      logging: true,
      context: { photoId },
    });
  }
  return res.status(200).json(settled);
};
