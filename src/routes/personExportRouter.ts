import express, { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handlePostPersonExportDownload } from "../controllers/personExport/handlePostPersonExportDownload.js";
import { handleLocalOrganizationDataDownload } from "../controllers/personExport/handleLocalOrganizationDataDownload.js";
import { handleLocalImage } from "../controllers/directory/handleLocalImage.js";
import { handleLocalPhotoUpload } from "../controllers/directory/handleLocalPhotoUpload.js";
import { MAX_PROFILE_PHOTO_BYTES } from "../services/directory/directoryPhotoServices.js";
import { tooLarge } from "./localAttachmentRouter.js";

export const personExportRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/person-exports/{exportId}/download:
   *   post:
   *     tags:
   *       - Person export
   *     summary: Sign a download link for a ready Person or Organization export
   *     description: |
   *       A fresh signed link to the ZIP, valid for one hour. It can be signed
   *       again as often as needed while the file lives, which is 7 days from
   *       `readyAt` (the `expiresAt` of the export). Only the person who
   *       requested the export may sign it; for anyone else the export does
   *       not exist. Every signing checks the requester still holds the
   *       standing they requested it with: the owner of the organization for
   *       an Organization export, an org admin of it for someone else's Person
   *       export.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: exportId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The signed link
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [url, expiresAt]
   *               properties:
   *                 url:
   *                   type: string
   *                   format: uri
   *                 expiresAt:
   *                   type: string
   *                   format: date-time
   *                   description: One hour from now.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           `context.code` is `FORBIDDEN`: the requester no longer owns the
   *           organization (Organization export) or no longer administers it
   *           (someone else's Person export)
   *       '404':
   *         description: No such export requested by the caller
   *       '409':
   *         description: "`context.code` is `EXPORT_NOT_READY`: still preparing, or the build failed"
   *       '410':
   *         description: "`context.code` is `EXPORT_EXPIRED`: the 7 days have passed"
   *       '422':
   *         description: Malformed export id
   *       '503':
   *         description: "`context.code` is `EXPORT_UNAVAILABLE`: no organization-data store is configured"
   * components:
   *   schemas:
   *     PersonExport:
   *       type: object
   *       required: [id, organizationId, scope, subjectUserId, status, createdAt, readyAt, expiresAt]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         organizationId:
   *           type: string
   *         scope:
   *           type: string
   *           enum: [PERSON, ORGANIZATION]
   *           description: A Person export or the owner's Organization export.
   *         subjectUserId:
   *           type: string
   *           nullable: true
   *           description: The person the export is about; null for an Organization export.
   *         status:
   *           type: string
   *           enum: [PENDING, READY, FAILED]
   *           description: |
   *             `PENDING` while the ZIP is being built (shown as Preparing),
   *             `READY` once it can be downloaded, `FAILED` after the last
   *             retry gave up.
   *         createdAt:
   *           type: string
   *           format: date-time
   *         readyAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *         expiresAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *           description: When the file goes, 7 days after `readyAt`.
   */
  app.post("/:exportId/download", tryCatch(handlePostPersonExportDownload));

  return app;
};

/**
 * The disk store's stand-in for S3's presigned GET. Mounted only when no
 * bucket is configured, and outside the session block: the signed URL is the
 * credential, as it is against S3.
 */
export const localOrganizationDataRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/organization-data/local:
   *   get:
   *     tags:
   *       - Person export
   *     summary: Download a file from the organization-data disk store (disk store only)
   *     description: |
   *       The `url` returned by `POST /api/person-exports/{exportId}/download`
   *       when the API runs without an organization-data bucket. Authorized by
   *       the signature over the other query parameters, not by a session.
   *     parameters:
   *       - { in: query, name: key, required: true, schema: { type: string } }
   *       - { in: query, name: name, required: true, schema: { type: string } }
   *       - { in: query, name: type, required: true, schema: { type: string } }
   *       - { in: query, name: expires, required: true, schema: { type: integer } }
   *       - { in: query, name: signature, required: true, schema: { type: string } }
   *     responses:
   *       '200':
   *         description: The file, as an attachment
   *         content:
   *           application/zip: {}
   *       '403':
   *         description: The signature is wrong or the link has expired
   *       '404':
   *         description: The file is gone
   */
  app.get("/", tryCatch(handleLocalOrganizationDataDownload));

  /**
   * @openapi
   * /api/organization-data/local/photos/{photoId}:
   *   put:
   *     tags:
   *       - Directory
   *     summary: Upload a Profile photo's bytes (disk store only)
   *     description: |
   *       The `upload.url` returned by `POST /api/directory/{organizationId}/people/{employmentId}/photo`
   *       when the API runs without an organization-data bucket. Authorized by
   *       `expires` and `signature`, not by a session. The bytes are rewritten
   *       into both sizes and the upload settles before the response.
   *     parameters:
   *       - { in: path, name: photoId, required: true, schema: { type: string, format: uuid } }
   *       - { in: query, name: expires, required: true, schema: { type: integer } }
   *       - { in: query, name: signature, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         image/png: {}
   *         image/jpeg: {}
   *         image/webp: {}
   *         image/heic: {}
   *     responses:
   *       '200':
   *         description: The settled upload
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ProfilePhotoUpload'
   *       '403':
   *         description: The link is invalid or has expired
   *       '409':
   *         description: The upload is no longer waiting for bytes
   *       '413':
   *         description: The body exceeds 10 MB
   *       '422':
   *         description: The body is empty
   */
  app.put(
    "/photos/:photoId",
    express.raw({ type: () => true, limit: MAX_PROFILE_PHOTO_BYTES }),
    tryCatch(handleLocalPhotoUpload)
  );

  /**
   * @openapi
   * /api/organization-data/local/image:
   *   get:
   *     tags:
   *       - Directory
   *     summary: Show an image from the organization-data disk store (disk store only)
   *     description: |
   *       The Profile photo links in directory responses when the API runs
   *       without an organization-data bucket. Authorized by the signature,
   *       and cached privately for an hour like the S3 link.
   *     parameters:
   *       - { in: query, name: key, required: true, schema: { type: string } }
   *       - { in: query, name: expires, required: true, schema: { type: integer } }
   *       - { in: query, name: signature, required: true, schema: { type: string } }
   *     responses:
   *       '200':
   *         description: The JPEG
   *         content:
   *           image/jpeg: {}
   *       '403':
   *         description: The signature is wrong or the link has expired
   *       '404':
   *         description: The image is gone
   */
  app.get("/image", tryCatch(handleLocalImage));

  app.use(tooLarge);

  return app;
};
