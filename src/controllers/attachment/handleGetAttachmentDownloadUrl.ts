import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { AttachmentStatus } from "../../db/schema/attachment-schema.js";
import {
  downloadFileName,
  getAttachmentById,
} from "../../services/attachment/attachmentServices.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { validateDownloadDisposition } from "../../services/attachment/types.js";
import { resolveVacationPermissions } from "../../services/vacation/vacationPermissions.js";
import { getRequestAnchorRow } from "../../services/vacation/vacationServices.js";

/** A short-lived URL for the bytes; the same callers the record detail refuses are refused here. */
export const handleGetAttachmentDownloadUrl = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const attachmentId = z.uuid().parse(req.params.id);
  const disposition = validateDownloadDisposition.parse(req.query.disposition);

  const attachment = await getAttachmentById(attachmentId);
  const record = attachment ? await getRequestAnchorRow(attachment.requestId) : undefined;
  if (!attachment || !record) {
    throw new AppError({
      message: "Attachment not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, attachmentId },
    });
  }

  const permissions = await resolveVacationPermissions(auth.userId, record);
  if (!permissions.canViewAttachments) {
    throw new AppError({
      message: "You are not allowed to view this attachment",
      logging: true,
      code: 403,
      context: { userId: auth.userId, attachmentId },
    });
  }

  if (attachment.status !== AttachmentStatus.Ready) {
    throw new AppError({
      message: "Attachment is not ready for download",
      logging: true,
      code: 409,
      context: { attachmentId, status: attachment.status },
      publicContext: { status: attachment.status, rejectionReason: attachment.rejectionReason },
    });
  }

  const fileName = downloadFileName(attachment);
  const { url, expiresAt } = await attachmentStore.createDownloadUrl({
    attachmentId,
    storageKey: attachment.storageKey,
    fileName,
    contentType: attachment.contentType,
    disposition,
  });

  return res.status(200).json({
    url,
    expiresAt,
    disposition,
    fileName,
    contentType: attachment.contentType,
  });
};
