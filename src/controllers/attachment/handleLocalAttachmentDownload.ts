import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { AttachmentStatus } from "../../db/schema/attachment-schema.js";
import {
  downloadFileName,
  getAttachmentById,
} from "../../services/attachment/attachmentServices.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { requireSignedLocalUrl } from "./signedLocalUrl.js";

// RFC 6266: an ASCII fallback for old clients plus the UTF-8 form for everyone else.
const contentDisposition = (disposition: string, fileName: string): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

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
  return res.status(200).send(bytes);
};
