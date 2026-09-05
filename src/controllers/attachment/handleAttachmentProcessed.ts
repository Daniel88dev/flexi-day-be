import type { Request, Response } from "express";
import { config } from "../../config.js";
import AppError from "../../utils/appError.js";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  verifyAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import { markAttachmentProcessed } from "../../services/attachment/attachmentServices.js";
import {
  ATTACHMENT_GONE_REASON,
  validateAttachmentProcessed,
} from "../../services/attachment/types.js";

/** The `attachment-processor` Lambda's report; the HMAC over the raw body is the only credential. */
export const handleAttachmentProcessed = async (req: Request, res: Response) => {
  const secret = config.attachments.callbackSecret;
  const body: unknown = req.body;
  const signature = req.header(ATTACHMENT_SIGNATURE_HEADER);
  if (!secret || !Buffer.isBuffer(body) || !verifyAttachmentCallback(secret, body, signature)) {
    throw new AppError({
      message: "Invalid attachment callback signature",
      logging: true,
      code: 401,
    });
  }

  const parsed = validateAttachmentProcessed.safeParse(parseJson(body));
  if (!parsed.success) {
    throw new AppError({
      message: "Malformed attachment callback",
      logging: true,
      code: 422,
      context: { issues: parsed.error.issues },
    });
  }
  const payload = parsed.data;

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

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};
