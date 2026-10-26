import express, { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { signedWebhookLimiter } from "../middleware/limiter.js";
import { handlePhotoProcessed } from "../controllers/directory/handlePhotoProcessed.js";

export const photoCallbackRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/directory/photos/processed:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Report a Profile photo's processing outcome (internal)
   *     description: |
   *       Called by the `attachment-processor` Lambda once it has checked an
   *       upload in the organization-data bucket and, for an accepted image,
   *       stored its small and full JPEG. Authenticated by
   *       `x-attachment-signature`, the hex HMAC-SHA256 of the raw body under
   *       the attachment callback secret; no session. A `READY` report makes
   *       the photo the Employment's Profile photo and deletes the one it
   *       replaces. A repeat delivery answers 409.
   *     operationId: handlePhotoProcessed
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
   *                 required: [photoId, status]
   *                 properties:
   *                   photoId: { type: string, format: uuid }
   *                   status: { type: string, enum: [READY] }
   *               - type: object
   *                 required: [photoId, status, rejectionReason]
   *                 properties:
   *                   photoId: { type: string, format: uuid }
   *                   status: { type: string, enum: [REJECTED] }
   *                   rejectionReason:
   *                     type: string
   *                     enum: [TYPE_MISMATCH, IMAGE_UNREADABLE]
   *     responses:
   *       '200':
   *         description: The settled upload
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ProfilePhotoUpload'
   *       '401':
   *         description: Missing or wrong signature
   *       '404':
   *         description: The upload is gone (`reason` is `PHOTO_GONE`); the sender deletes what it stored
   *       '409':
   *         description: Already processed; `context.status` says how it settled
   *       '422':
   *         description: The body is not a valid report
   */
  app.post(
    "/",
    express.raw({ type: "application/json" }),
    signedWebhookLimiter,
    tryCatch(handlePhotoProcessed)
  );

  return app;
};
