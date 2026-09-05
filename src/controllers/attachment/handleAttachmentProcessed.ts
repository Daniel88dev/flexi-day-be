import type { Request, Response } from "express";
import { config } from "../../config.js";
import AppError from "../../utils/appError.js";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  verifyAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import { markAttachmentProcessed } from "../../services/attachment/attachmentServices.js";
import { validateAttachmentProcessed } from "../../services/attachment/types.js";

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
    throw new AppError({
      message: "Attachment not found",
      logging: true,
      code: 404,
      context: { attachmentId: payload.attachmentId },
    });
  }
  if (!result.changed) {
    throw new AppError({
      message: "Attachment has already been processed",
      logging: true,
      code: 409,
      context: { attachmentId: payload.attachmentId, status: result.attachment.status },
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
