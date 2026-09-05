import express, { Router, type ErrorRequestHandler } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import AppError from "../utils/appError.js";
import { MAX_ATTACHMENT_BYTES } from "../services/attachment/types.js";
import { handleLocalAttachmentUpload } from "../controllers/attachment/handleLocalAttachmentUpload.js";
import { handleLocalAttachmentDownload } from "../controllers/attachment/handleLocalAttachmentDownload.js";

// body-parser's own 413 is not an AppError, so errorMiddleware would report a 500.
const tooLarge: ErrorRequestHandler = (err: unknown, _req, _res, next) => {
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.too.large") {
    return next(
      new AppError({
        message: "File exceeds the 10 MB limit",
        logging: true,
        code: 413,
        publicContext: { reason: "FILE_TOO_LARGE", limit: MAX_ATTACHMENT_BYTES },
      })
    );
  }
  next(err);
};

/**
 * The disk store's stand-ins for S3's presigned URLs. Mounted only when no
 * bucket is configured, and outside the session block: the signed URL is the
 * credential, as it will be against S3.
 */
export const localAttachmentRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/attachments/local/upload/{id}:
   *   put:
   *     tags:
   *       - Attachments
   *     summary: Upload the bytes of an attachment (disk store only)
   *     description: |
   *       The `upload.url` returned by `POST /api/attachments` when the API runs
   *       without an S3 bucket. Authorized by the `expires` and `signature`
   *       query parameters, not by a session. The bytes are checked and stored
   *       before the response, which reports the settled status.
   *     operationId: handleLocalAttachmentUpload
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: expires
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *       - name: signature
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         image/png: {}
   *         image/jpeg: {}
   *         image/webp: {}
   *         application/pdf: {}
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
   *       '403':
   *         description: The link is invalid or has expired
   *       '404':
   *         description: Attachment not found
   *       '409':
   *         description: The attachment was already uploaded
   *       '413':
   *         description: The body exceeds 10 MB
   *       '422':
   *         description: The body is empty
   */
  app.put(
    "/upload/:id",
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    tryCatch(handleLocalAttachmentUpload)
  );

  /**
   * @openapi
   * /api/attachments/local/download/{id}:
   *   get:
   *     tags:
   *       - Attachments
   *     summary: Fetch the bytes of an attachment (disk store only)
   *     description: |
   *       The `url` returned by the download-url endpoint when the API runs
   *       without an S3 bucket. Authorized by `expires` and `signature`, which
   *       also bind the `disposition`. Answers with the bytes, their
   *       `Content-Type` and a `Content-Disposition` carrying the file name.
   *     operationId: handleLocalAttachmentDownload
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: expires
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *       - name: disposition
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *           enum: [inline, attachment]
   *       - name: signature
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The file bytes
   *         content:
   *           image/jpeg: {}
   *           application/pdf: {}
   *       '403':
   *         description: The link is invalid or has expired
   *       '404':
   *         description: Attachment not found or not ready
   */
  app.get("/download/:id", tryCatch(handleLocalAttachmentDownload));

  app.use(tooLarge);

  return app;
};
