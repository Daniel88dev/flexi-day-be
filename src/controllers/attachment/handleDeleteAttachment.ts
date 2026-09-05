import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import {
  deleteAttachment,
  getAttachmentById,
  toAttachmentView,
} from "../../services/attachment/attachmentServices.js";
import { resolveVacationPermissions } from "../../services/vacation/vacationPermissions.js";
import { getVacationsByRequestId } from "../../services/vacation/vacationServices.js";

/** The uploader or a group admin removes the file; the row stays as the history entry. */
export const handleDeleteAttachment = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const attachmentId = z.uuid().parse(req.params.id);

  const attachment = await getAttachmentById(attachmentId);
  const [record] = attachment ? await getVacationsByRequestId(attachment.requestId) : [];
  if (!attachment || !record) {
    throw new AppError({
      message: "Attachment not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, attachmentId },
    });
  }

  const permissions = await resolveVacationPermissions(auth.userId, record);
  const isUploader = attachment.uploadedByUserId === auth.userId;
  if (!isUploader && !permissions.canDeleteAnyAttachment) {
    throw new AppError({
      message: "You are not allowed to delete this attachment",
      logging: true,
      code: 403,
      context: { userId: auth.userId, attachmentId },
    });
  }

  const deleted = await deleteAttachment(attachmentId, auth.userId);
  if (!deleted) {
    throw new AppError({
      message: "Attachment was already deleted",
      logging: true,
      code: 409,
      context: { userId: auth.userId, attachmentId },
    });
  }

  return res.status(200).json({ attachment: toAttachmentView(deleted) });
};
