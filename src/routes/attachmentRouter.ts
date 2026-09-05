import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePostAttachment } from "../services/attachment/types.js";
import { handlePostAttachment } from "../controllers/attachment/handlePostAttachment.js";
import { handleGetAttachmentDownloadUrl } from "../controllers/attachment/handleGetAttachmentDownloadUrl.js";

export const attachmentRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/attachments:
   *   post:
   *     tags:
   *       - Attachments
   *     summary: Attach a file to a Request
   *     description: |
   *       Registers an attachment on the Request (the set of vacation rows
   *       sharing `requestId`) and returns the target the browser must upload
   *       the bytes to. The attachment starts as `UPLOADING`; once the bytes
   *       land they are checked and the row becomes `READY` (images are
   *       rewritten to JPEG, at most 2048 px on the long edge, metadata
   *       stripped) or `REJECTED` with a `rejectionReason`. Poll the record
   *       detail to see the outcome.
   *
   *       Allowed for the record owner and anyone who may edit the record
   *       (group and organization admins). Requires a paid plan, grace
   *       included. At most five attachments in `UPLOADING` or `READY` state
   *       per Request.
   *     operationId: handlePostAttachment
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [requestId, fileName, contentType, size]
   *             properties:
   *               requestId:
   *                 type: string
   *                 format: uuid
   *               fileName:
   *                 type: string
   *                 maxLength: 255
   *                 description: The original file name, kept for download.
   *               contentType:
   *                 type: string
   *                 enum: [image/png, image/jpeg, image/webp, application/pdf]
   *               size:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 10485760
   *                 description: Declared size in bytes; 10 MB at most.
   *     responses:
   *       '201':
   *         description: The attachment row and where to send its bytes
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 attachment:
   *                   $ref: '#/components/schemas/Attachment'
   *                 upload:
   *                   $ref: '#/components/schemas/UploadTarget'
   *       '401':
   *         description: Unauthorized
   *       '402':
   *         description: The organization is not on a paid plan (`reason` is `PLAN_LIMIT`)
   *       '403':
   *         description: Not the record owner and not allowed to edit the record
   *       '404':
   *         description: Request not found
   *       '422':
   *         description: |
   *           Unsupported type (`reason` `UNSUPPORTED_TYPE`), file over 10 MB
   *           (`FILE_TOO_LARGE`), or the Request already has five attachments
   *           (`ATTACHMENT_LIMIT`)
   * components:
   *   schemas:
   *     Attachment:
   *       type: object
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         requestId:
   *           type: string
   *           format: uuid
   *         fileName:
   *           type: string
   *           description: The original file name as uploaded.
   *         contentType:
   *           type: string
   *           description: The stored type. Images become `image/jpeg` once processed.
   *         size:
   *           type: integer
   *           description: Bytes as declared while uploading, then the stored size once ready.
   *         status:
   *           type: string
   *           enum: [UPLOADING, READY, REJECTED]
   *         rejectionReason:
   *           type: string
   *           nullable: true
   *           enum: [TYPE_MISMATCH, IMAGE_UNREADABLE, PDF_JAVASCRIPT, PDF_LAUNCH_ACTION, PDF_ENCRYPTED]
   *           description: Set only while `status` is `REJECTED`.
   *         uploadedByUserId:
   *           type: string
   *           nullable: true
   *           description: Who registered the attachment; differs from the owner when an admin did.
   *         createdAt:
   *           type: string
   *           format: date-time
   *     UploadTarget:
   *       type: object
   *       description: |
   *         Send the file bytes here with the given method and headers and no
   *         session. Locally this is the API's own route; in production it is a
   *         presigned S3 request.
   *       properties:
   *         url:
   *           type: string
   *           format: uri
   *         method:
   *           type: string
   *           enum: [PUT]
   *         headers:
   *           type: object
   *           additionalProperties:
   *             type: string
   *         expiresAt:
   *           type: string
   *           format: date-time
   */
  app.post("/", bodyValidationMiddleware(validatePostAttachment), tryCatch(handlePostAttachment));

  /**
   * @openapi
   * /api/attachments/{id}/download-url:
   *   get:
   *     tags:
   *       - Attachments
   *     summary: A short-lived URL for the attachment's bytes
   *     description: |
   *       Allowed for the record owner, the group's approvers and its group and
   *       organization admins, the same callers the record detail shows
   *       attachments to. The URL carries no session and expires after a few
   *       minutes; `fileName` is the original name, with the extension changed
   *       to `.jpg` for images the processor rewrote.
   *     operationId: handleGetAttachmentDownloadUrl
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: disposition
   *         in: query
   *         required: false
   *         description: How the browser should treat the bytes. Defaults to `inline`.
   *         schema:
   *           type: string
   *           enum: [inline, attachment]
   *     responses:
   *       '200':
   *         description: Where to fetch the bytes
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 url:
   *                   type: string
   *                   format: uri
   *                 expiresAt:
   *                   type: string
   *                   format: date-time
   *                 disposition:
   *                   type: string
   *                   enum: [inline, attachment]
   *                 fileName:
   *                   type: string
   *                 contentType:
   *                   type: string
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: Not allowed to view this attachment
   *       '404':
   *         description: Attachment not found
   *       '409':
   *         description: The attachment is not `READY` (`status` and `rejectionReason` say why)
   */
  app.get("/:id/download-url", tryCatch(handleGetAttachmentDownloadUrl));

  return app;
};
