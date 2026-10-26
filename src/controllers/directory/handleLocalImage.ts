import type { Request, Response } from "express";
import { z } from "zod";
import {
  IMAGE_URL_WINDOW_MS,
  organizationDataStore,
  verifyLocalImage,
} from "../../services/organizationData/organizationDataStore.js";
import AppError from "../../utils/appError.js";

const signedQuery = z.object({
  key: z.string().min(1),
  expires: z.coerce.number().int(),
  signature: z.string().min(1),
});

/** The disk store's stand-in for a presigned image GET, cached like the S3 link. */
export const handleLocalImage = async (req: Request, res: Response) => {
  const parsed = signedQuery.safeParse(req.query);
  if (
    !parsed.success ||
    !verifyLocalImage({ key: parsed.data.key, expires: parsed.data.expires }, parsed.data.signature)
  ) {
    throw new AppError({ code: 403, message: "Invalid or expired link", logging: false });
  }
  const bytes = await organizationDataStore?.getObject(parsed.data.key);
  if (!bytes) throw new AppError({ code: 404, message: "Image not found", logging: false });

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", `private, max-age=${(IMAGE_URL_WINDOW_MS / 1000).toString()}`);
  // Like the attachment stand-in: S3 sends no CORP, so the frontend may embed it.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.status(200).send(bytes);
};
