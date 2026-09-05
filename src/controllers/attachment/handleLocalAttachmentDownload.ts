import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { AttachmentStatus } from "../../db/schema/attachment-schema.js";
import {
  downloadFileName,
  getAttachmentById,
} from "../../services/attachment/attachmentServices.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { contentDisposition } from "../../services/attachment/contentDisposition.js";
import { requireSignedLocalUrl } from "./signedLocalUrl.js";

/** The disk store's stand-in for a presigned S3 GET; see the upload handler. */
export const handleLocalAttachmentDownload = async (req: Request, res: Response) => {
  const { attachmentId, disposition } = requireSignedLocalUrl(req, "download");

  const attachment = await getAttachmentById(attachmentId);
  const bytes =
    attachment?.status === AttachmentStatus.Ready
      ? await attachmentStore.getObject(attachment.storageKey)
      : undefined;
  if (!attachment || !bytes) {
    throw new AppError({
      message: "Attachment not found",
      logging: true,
      code: 404,
      context: { attachmentId },
    });
  }

  res.setHeader("Content-Type", attachment.contentType);
  res.setHeader(
    "Content-Disposition",
    contentDisposition(disposition, downloadFileName(attachment))
  );
  res.setHeader("Cache-Control", "private, no-store");
  // Helmet's same-origin CORP would stop the frontend embedding the image in
  // an <img>; S3 sends no such header, so the stand-in must not either.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.status(200).send(bytes);
};
