import { z } from "zod";
import type { AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { AttachmentRejectionReason, STORED_CONTENT_TYPES } from "./processor.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;
/** Attachments outlive the Request's last day by this much, then the nightly sweep removes them. */
export const ATTACHMENT_RETENTION_MONTHS = 12;
/** An `UPLOADING` row this old never got its bytes; the sweep clears it. */
export const STALE_UPLOAD_MS = 10 * 60 * 1000;
export const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
/** The callback's 404 carries this, so the Lambda can tell a deleted row from an unknown route. */
export const ATTACHMENT_GONE_REASON = "ATTACHMENT_GONE";
export const DOWNLOAD_URL_TTL_MS = 60 * 1000;

export type AttachmentType = {
  id: string;
  requestId: string;
  organizationId: string;
  ownerUserId: string;
  uploadedByUserId: string | null;
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
  status: AttachmentStatus;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedByUserId: string | null;
};

export type AttachmentInsertType = Pick<
  AttachmentType,
  | "id"
  | "requestId"
  | "organizationId"
  | "ownerUserId"
  | "uploadedByUserId"
  | "fileName"
  | "contentType"
  | "size"
  | "storageKey"
>;

/** What the API shows about an attachment; the storage key stays server-side. */
export type AttachmentView = Pick<
  AttachmentType,
  | "id"
  | "requestId"
  | "fileName"
  | "contentType"
  | "size"
  | "status"
  | "rejectionReason"
  | "uploadedByUserId"
  | "createdAt"
  | "deletedAt"
  | "deletedByUserId"
>;

/**
 * Where the browser sends the bytes. Against S3 it is a presigned POST: a
 * multipart form carrying `fields` and then the file. The disk store's own
 * route takes a plain PUT of the bytes with `headers`.
 */
export type UploadTarget =
  | { url: string; method: "POST"; fields: Record<string, string>; expiresAt: string }
  | { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };

export type AttachmentDisposition = "inline" | "attachment";

/**
 * The store port (docs/adr/0003). The download input carries what a presigned
 * GET needs to name the file; the disk adapter looks the row up again instead.
 */
export type AttachmentStore = {
  createUploadTarget(input: {
    attachmentId: string;
    contentType: string;
    size: number;
    storageKey: string;
  }): Promise<UploadTarget>;
  createDownloadUrl(input: {
    attachmentId: string;
    storageKey: string;
    fileName: string;
    contentType: string;
    disposition: AttachmentDisposition;
  }): Promise<{ url: string; expiresAt: string }>;
  putObject(key: string, bytes: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer | undefined>;
  deleteObject(key: string): Promise<void>;
};

export const validatePostAttachment = z.object({
  requestId: z.uuid(),
  fileName: z.string().trim().min(1).max(255),
  // Free-form on purpose: an unsupported type answers 422 with a reason the
  // client can show, not a schema error.
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
});

export type ValidatedPostAttachmentType = z.infer<typeof validatePostAttachment>;

export const validateDownloadDisposition = z
  .enum(["inline", "attachment"])
  .default("inline")
  .catch("inline");

const readyOutcome = z.object({
  status: z.literal("READY"),
  contentType: z.enum(STORED_CONTENT_TYPES),
  size: z.number().int().positive(),
});

const rejectedOutcome = z.object({
  status: z.literal("REJECTED"),
  rejectionReason: z.enum(AttachmentRejectionReason),
});

/** The processor's verdict alone, without the row it is about. */
export const validateAttachmentOutcome = z.discriminatedUnion("status", [
  readyOutcome,
  rejectedOutcome,
]);

export type AttachmentProcessedOutcome = z.infer<typeof validateAttachmentOutcome>;

const withAttachmentId = { attachmentId: z.uuid() };

/** What the Lambda reports once the bytes are checked. */
export const validateAttachmentProcessed = z.discriminatedUnion("status", [
  readyOutcome.extend(withAttachmentId),
  rejectedOutcome.extend(withAttachmentId),
]);

export type AttachmentProcessedPayload = z.infer<typeof validateAttachmentProcessed>;
