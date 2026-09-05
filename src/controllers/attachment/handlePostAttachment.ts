import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { db } from "../../db/db.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
  type ValidatedPostAttachmentType,
} from "../../services/attachment/types.js";
import {
  countAttachmentSlotsUsed,
  createAttachment,
  lockRequestForAttachments,
  toAttachmentView,
} from "../../services/attachment/attachmentServices.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { isRequestPastRetention } from "../../services/attachment/attachmentRetention.js";
import {
  ATTACHMENT_CONTENT_TYPES,
  isAttachmentContentType,
} from "../../services/attachment/processor.js";
import { assertAttachmentUploadAvailable } from "../../services/billing/guards.js";
import { getGroup } from "../../services/group/groupServices.js";
import { resolveVacationPermissions } from "../../services/vacation/vacationPermissions.js";
import { getRequestAnchorRow } from "../../services/vacation/vacationServices.js";

/**
 * Registers an attachment on a Request and returns where to send its bytes.
 * The row starts as `UPLOADING`; the store settles it once the bytes land.
 */
export const handlePostAttachment = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostAttachmentType = req.body;

  const record = await getRequestAnchorRow(data.requestId);
  if (!record) {
    throw new AppError({
      message: "Request not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, requestId: data.requestId },
    });
  }

  const permissions = await resolveVacationPermissions(auth.userId, record);
  if (!permissions.canAttach) {
    throw new AppError({
      message: "You are not allowed to attach files to this request",
      logging: true,
      code: 403,
      context: { userId: auth.userId, requestId: data.requestId },
    });
  }

  if (await isRequestPastRetention(data.requestId)) {
    throw new AppError({
      message: "This request is past the attachment retention period",
      logging: true,
      code: 403,
      context: { userId: auth.userId, requestId: data.requestId },
      publicContext: { reason: "RETENTION_EXPIRED" },
    });
  }

  const group = await getGroup(record.groupId);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { groupId: record.groupId },
    });
  }

  await assertAttachmentUploadAvailable(group.organizationId);

  if (!isAttachmentContentType(data.contentType)) {
    throw new AppError({
      message: "Only PNG, JPEG, WebP, HEIC and PDF files can be attached",
      logging: true,
      code: 422,
      context: { contentType: data.contentType },
      publicContext: { reason: "UNSUPPORTED_TYPE", allowed: ATTACHMENT_CONTENT_TYPES },
    });
  }

  if (data.size > MAX_ATTACHMENT_BYTES) {
    throw new AppError({
      message: "File exceeds the 10 MB limit",
      logging: true,
      code: 422,
      context: { size: data.size },
      publicContext: { reason: "FILE_TOO_LARGE", limit: MAX_ATTACHMENT_BYTES },
    });
  }

  const attachmentId = generateRandomUUID();

  const created = await db.transaction(async (tx) => {
    await lockRequestForAttachments(data.requestId, tx);

    const used = await countAttachmentSlotsUsed(data.requestId, tx);
    if (used >= MAX_ATTACHMENTS_PER_REQUEST) {
      throw new AppError({
        message: "This request already has the maximum number of attachments",
        logging: true,
        code: 422,
        context: { requestId: data.requestId, used },
        publicContext: {
          reason: "ATTACHMENT_LIMIT",
          limit: MAX_ATTACHMENTS_PER_REQUEST,
          current: used,
        },
      });
    }

    return createAttachment(
      {
        id: attachmentId,
        requestId: data.requestId,
        organizationId: group.organizationId,
        ownerUserId: record.userId,
        uploadedByUserId: auth.userId,
        fileName: data.fileName,
        contentType: data.contentType,
        size: data.size,
        storageKey: `${group.organizationId}/${record.userId}/${attachmentId}`,
      },
      tx
    );
  });

  const upload = await attachmentStore.createUploadTarget({
    attachmentId: created.id,
    contentType: created.contentType,
    size: created.size,
    storageKey: created.storageKey,
  });

  return res.status(201).json({ attachment: toAttachmentView(created), upload });
};
