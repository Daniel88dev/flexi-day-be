import { z } from "zod";
import type { AttachmentStatus } from "../../db/schema/attachment-schema.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;

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
>;

/** Where the browser sends the bytes: a presigned S3 request, or the disk store's own route. */
export type UploadTarget = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

export type AttachmentDisposition = "inline" | "attachment";

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
