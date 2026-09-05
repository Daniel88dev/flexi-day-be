import {
  AttachmentRejectionReason,
  isAttachmentContentType,
  processAttachment,
} from "../../services/attachment/processor.js";
import { finalStorageKey, type UPLOAD_METADATA } from "../../services/attachment/s3Layout.js";
import type {
  AttachmentProcessedOutcome,
  AttachmentProcessedPayload,
} from "../../services/attachment/types.js";

/** The part of an S3 object-created event the handler reads. */
export type S3ObjectCreatedEvent = { Records: { s3: { object: { key: string } } }[] };

type UploadMetadataKey = (typeof UPLOAD_METADATA)[keyof typeof UPLOAD_METADATA];

export type IncomingObject = {
  bytes: Buffer;
  /** The `Content-Type` the presigned POST pinned: the type the uploader claimed. */
  contentType: string | undefined;
  metadata: Partial<Record<UploadMetadataKey, string>>;
};

/** The handler's view of the bucket, so a test can stand in for S3. */
export type ObjectStore = {
  get(key: string): Promise<IncomingObject | undefined>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/** `gone` when the API no longer has the row: it was deleted while the bytes were in flight. */
export type NotifyResult = "settled" | "gone";

export type ProcessorDeps = {
  store: ObjectStore;
  /** Delivers the report to the API; must throw when it did not land. */
  notify: (payload: AttachmentProcessedPayload) => Promise<NotifyResult>;
  log?: (message: string, context: Record<string, unknown>) => void;
};

// S3 writes keys into events URL-encoded, with spaces as `+`.
const decodeKey = (key: string): string => decodeURIComponent(key.replace(/\+/g, " "));

/**
 * What the disk store does in-process (`completeUpload`), split across the
 * bucket and the API: check the bytes, write the result under the final key,
 * report, and only then drop the incoming object. A report that fails to land
 * leaves the object in place, so the retried event does the whole step again
 * and the API's 409 on the repeat tells the notifier the row already moved.
 */
export const createHandler = ({ store, notify, log = console.log }: ProcessorDeps) => {
  const check = async (
    object: IncomingObject,
    storageKey: string
  ): Promise<AttachmentProcessedOutcome> => {
    const claimed = object.contentType ?? "";
    if (!isAttachmentContentType(claimed)) {
      return { status: "REJECTED", rejectionReason: AttachmentRejectionReason.TypeMismatch };
    }
    const processed = await processAttachment(object.bytes, claimed);
    if (!processed.ok) return { status: "REJECTED", rejectionReason: processed.reason };

    await store.put(
      finalStorageKey(storageKey, processed.contentType),
      processed.bytes,
      processed.contentType
    );
    return { status: "READY", contentType: processed.contentType, size: processed.bytes.length };
  };

  const processObject = async (key: string): Promise<void> => {
    const object = await store.get(key);
    if (!object) {
      log("Incoming attachment object is already gone", { key });
      return;
    }
    const { "attachment-id": attachmentId, "storage-key": storageKey } = object.metadata;
    if (!attachmentId || !storageKey) {
      log("Incoming attachment object carries no row metadata; dropping it", { key });
      await store.delete(key);
      return;
    }

    const outcome = await check(object, storageKey);
    const result = await notify({ attachmentId, ...outcome });
    if (result === "gone" && outcome.status === "READY") {
      await store.delete(finalStorageKey(storageKey, outcome.contentType));
    }
    await store.delete(key);
    log("Attachment processed", { attachmentId, status: outcome.status, result });
  };

  return async (event: S3ObjectCreatedEvent): Promise<void> => {
    for (const record of event.Records) {
      await processObject(decodeKey(record.s3.object.key));
    }
  };
};
