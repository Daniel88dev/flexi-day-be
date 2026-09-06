import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { completeUpload, getAttachmentById } from "../../services/attachment/attachmentServices.js";
import { requireSignedLocalUrl } from "./signedLocalUrl.js";

/**
 * The disk store's stand-in for a presigned S3 PUT. No session: the signed URL
 * is the credential, exactly as it will be against S3.
 */
export const handleLocalAttachmentUpload = async (req: Request, res: Response) => {
  const { attachmentId } = requireSignedLocalUrl(req, "upload");

  const attachment = await getAttachmentById(attachmentId);
  if (!attachment) {
    throw new AppError({
      message: "Attachment not found",
      logging: true,
      code: 404,
      context: { attachmentId },
    });
  }

  const bytes: unknown = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new AppError({
      message: "Upload body is empty",
      logging: true,
      code: 422,
      context: { attachmentId },
    });
  }

  const settled =
    attachment.status === AttachmentStatus.Uploading
      ? await completeUpload(attachmentId, bytes)
      : undefined;
  if (!settled) {
    throw new AppError({
      message: "Attachment has already been uploaded",
      logging: true,
      code: 409,
      context: { attachmentId, status: attachment.status },
    });
  }

  return res.status(200).json({
    id: settled.id,
    status: settled.status,
    rejectionReason: settled.rejectionReason,
  });
};
