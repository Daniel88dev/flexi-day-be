import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { markAttachmentProcessed } from "../../services/attachment/attachmentServices.js";
import {
  ATTACHMENT_GONE_REASON,
  validateAttachmentProcessed,
} from "../../services/attachment/types.js";
import { readSignedCallback } from "./readSignedCallback.js";

/** The `attachment-processor` Lambda's report; the HMAC over the raw body is the only credential. */
export const handleAttachmentProcessed = async (req: Request, res: Response) => {
  const payload = readSignedCallback(req, validateAttachmentProcessed, "attachment");

  const result = await markAttachmentProcessed(payload);
  if (!result) {
    // The reason is what the Lambda checks before it drops the bytes: a bare
    // 404 could also be a wrong API_URL, which must not cost the upload.
    throw new AppError({
      message: "Attachment not found",
      logging: true,
      code: 404,
      context: { attachmentId: payload.attachmentId },
      publicContext: { reason: ATTACHMENT_GONE_REASON },
    });
  }
  if (!result.changed) {
    // How it settled is what the Lambda checks before it drops bytes it
    // wrote: a parallel delivery may have settled the row on exactly those.
    const { status, contentType } = result.attachment;
    throw new AppError({
      message: "Attachment has already been processed",
      logging: true,
      code: 409,
      context: { attachmentId: payload.attachmentId, status },
      publicContext: { status, contentType },
    });
  }

  return res.status(200).json({
    id: result.attachment.id,
    status: result.attachment.status,
    rejectionReason: result.attachment.rejectionReason,
  });
};
