import type { StoredContentType } from "./processor.js";

/**
 * Where bytes live in the bucket, shared by the API (which presigns) and the
 * `attachment-processor` Lambda (which moves them). The browser posts to
 * `incoming/<attachmentId>`; the Lambda writes the checked result under the
 * row's storage key plus the stored type's extension.
 */
export const INCOMING_PREFIX = "incoming/";

export const incomingKey = (attachmentId: string): string => `${INCOMING_PREFIX}${attachmentId}`;

/**
 * S3 object metadata the presigned POST pins, so the Lambda learns which row
 * an object belongs to without a database. S3 hands them back lower-cased
 * and without the `x-amz-meta-` prefix.
 */
export const UPLOAD_METADATA = {
  attachmentId: "attachment-id",
  storageKey: "storage-key",
} as const;

/** The row's storage key is extension-less until the bytes are checked; the stored type decides it. */
export const finalStorageKey = (storageKey: string, contentType: StoredContentType): string =>
  `${storageKey}.${contentType === "image/jpeg" ? "jpg" : "pdf"}`;
