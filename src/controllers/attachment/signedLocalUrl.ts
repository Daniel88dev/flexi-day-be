import type { Request } from "express";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { verifyLocalSignature } from "../../services/attachment/attachmentStore.js";
import {
  validateDownloadDisposition,
  type AttachmentDisposition,
} from "../../services/attachment/types.js";

const signedQuery = z.object({
  expires: z.coerce.number(),
  signature: z.string().min(1),
  disposition: validateDownloadDisposition,
});

/** The signed URL is the only credential on the disk store's routes; a bad or stale one is a 403. */
export const requireSignedLocalUrl = (
  req: Request,
  purpose: "upload" | "download"
): { attachmentId: string; disposition: AttachmentDisposition } => {
  const attachmentId = z.uuid().parse(req.params.id);
  const query = signedQuery.safeParse(req.query);
  const disposition = query.success ? query.data.disposition : "inline";

  const valid =
    query.success &&
    verifyLocalSignature(
      {
        purpose,
        attachmentId,
        expires: query.data.expires,
        ...(purpose === "download" ? { disposition } : {}),
      },
      query.data.signature
    );
  if (!valid) {
    throw new AppError({
      message: `${purpose === "upload" ? "Upload" : "Download"} link is invalid or has expired`,
      logging: true,
      code: 403,
      context: { attachmentId, purpose },
    });
  }
  return { attachmentId, disposition };
};
