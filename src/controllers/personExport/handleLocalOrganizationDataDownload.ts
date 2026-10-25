import type { Request, Response } from "express";
import { z } from "zod";
import { contentDisposition } from "../../services/attachment/contentDisposition.js";
import {
  organizationDataStore,
  verifyLocalDownload,
} from "../../services/organizationData/organizationDataStore.js";
import AppError from "../../utils/appError.js";

const signedQuery = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  expires: z.coerce.number().int(),
  signature: z.string().min(1),
});

/** The disk store's stand-in for a presigned S3 GET, authorized by its signature alone. */
export const handleLocalOrganizationDataDownload = async (req: Request, res: Response) => {
  const parsed = signedQuery.safeParse(req.query);
  const signed = parsed.success
    ? {
        key: parsed.data.key,
        fileName: parsed.data.name,
        contentType: parsed.data.type,
        expires: parsed.data.expires,
      }
    : undefined;
  if (!parsed.success || !signed || !verifyLocalDownload(signed, parsed.data.signature)) {
    throw new AppError({ code: 403, message: "Invalid or expired link", logging: false });
  }

  const bytes = await organizationDataStore?.getObject(signed.key);
  if (!bytes) throw new AppError({ code: 404, message: "File not found", logging: true });

  res.setHeader("Content-Type", signed.contentType);
  res.setHeader("Content-Disposition", contentDisposition("attachment", signed.fileName));
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(bytes);
};
