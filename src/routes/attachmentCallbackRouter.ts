import express, { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { signedWebhookLimiter } from "../middleware/limiter.js";
import { handleAttachmentProcessed } from "../controllers/attachment/handleAttachmentProcessed.js";

export const attachmentCallbackRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/attachments/processed:
   *   post:
   *     tags:
   *       - Attachments
   *     summary: Report an attachment's processing outcome (internal)
   *     description: |
   *       Called by the `attachment-processor` Lambda once it has checked the
   *       uploaded bytes and, for an accepted file, written them under the
   *       final key. Authenticated by `x-attachment-signature`, the hex
   *       HMAC-SHA256 of the raw request body under the shared callback
   *       secret; no session. Applies the same `READY` or `REJECTED`
   *       transition the local disk store applies in-process, so the row
   *       moves exactly once: a repeat delivery answers 409.
   *     operationId: handleAttachmentProcessed
   *     parameters:
   *       - name: x-attachment-signature
   *         in: header
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             oneOf:
   *               - type: object
   *                 required: [attachmentId, status, contentType, size]
   *                 properties:
   *                   attachmentId:
   *                     type: string
   *                     format: uuid
   *                   status:
   *                     type: string
   *                     enum: [READY]
   *                   contentType:
   *                     type: string
   *                     enum: [image/jpeg, application/pdf]
   *                     description: The stored type; decides the final key's extension.
   *                   size:
   *                     type: integer
   *                     minimum: 1
   *                     description: Bytes as stored, after processing.
   *               - type: object
   *                 required: [attachmentId, status, rejectionReason]
   *                 properties:
   *                   attachmentId:
   *                     type: string
   *                     format: uuid
   *                   status:
   *                     type: string
   *                     enum: [REJECTED]
   *                   rejectionReason:
   *                     type: string
   *                     enum: [TYPE_MISMATCH, IMAGE_UNREADABLE, PDF_JAVASCRIPT, PDF_LAUNCH_ACTION, PDF_ENCRYPTED]
   *     responses:
   *       '200':
   *         description: The attachment's settled status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   *                   format: uuid
   *                 status:
   *                   type: string
   *                   enum: [READY, REJECTED]
   *                 rejectionReason:
   *                   type: string
   *                   nullable: true
   *       '401':
   *         description: Missing or wrong signature
   *       '404':
   *         description: Attachment not found or deleted
   *       '409':
   *         description: The attachment was already processed
   *       '422':
   *         description: The body is not a valid report
   */
  app.post(
    "/",
    express.raw({ type: "application/json" }),
    signedWebhookLimiter,
    tryCatch(handleAttachmentProcessed)
  );

  return app;
};
