import { processProfilePhoto } from "../../services/attachment/processor.js";
import type { PhotoProcessedPayload } from "../../services/directory/types.js";
import { PHOTO_UPLOAD_METADATA } from "../../services/organizationData/photoUploadMetadata.js";
import type { NotifyResult, ObjectStore } from "./handler.js";

export type PhotoProcessorDeps = {
  store: ObjectStore;
  /** Delivers the report to the API; must throw when it did not land. */
  notify: (payload: PhotoProcessedPayload) => Promise<NotifyResult>;
  log?: (message: string, context: Record<string, unknown>) => void;
};

/**
 * Whether the two sizes must go: the photo is gone, or another delivery
 * settled it as anything but READY after this one wrote them. Each upload
 * has a key of its own, so a READY photo serves exactly these objects.
 */
const orphaned = (reply: NotifyResult, written: boolean): boolean => {
  if (reply.result === "gone") return true;
  if (reply.result !== "already" || !written || !reply.row) return false;
  return reply.row.status !== "READY";
};

/**
 * What the disk store does in-process for a Profile photo, split across the
 * organization-data bucket and the API: rewrite the bytes into two JPEGs,
 * store them under the photo's folder, report, then drop the incoming
 * object. A report that fails to land leaves the object for the retry.
 */
export const createPhotoHandler =
  ({ store, notify, log = console.log }: PhotoProcessorDeps) =>
  async (key: string): Promise<void> => {
    const object = await store.get(key);
    if (!object) {
      log("Incoming photo object is already gone", { key });
      return;
    }
    const photoId = object.metadata[PHOTO_UPLOAD_METADATA.photoId];
    const storageKey = object.metadata[PHOTO_UPLOAD_METADATA.storageKey];
    if (!photoId || !storageKey) {
      log("Incoming photo object carries no photo metadata; dropping it", { key });
      await store.delete(key);
      return;
    }

    const processed = await processProfilePhoto(object.bytes, object.contentType ?? "");
    const keys = [`${storageKey}small.jpg`, `${storageKey}full.jpg`];
    let written = false;
    if (processed.ok) {
      const small = await store.put(keys[0]!, processed.small, "image/jpeg");
      const full = await store.put(keys[1]!, processed.full, "image/jpeg");
      written = small || full;
    }

    const reply = await notify(
      processed.ok
        ? { photoId, status: "READY" }
        : { photoId, status: "REJECTED", rejectionReason: processed.reason }
    );
    if (processed.ok && orphaned(reply, written)) {
      for (const stored of keys) await store.delete(stored);
    }
    await store.delete(key);
    log("Photo processed", { photoId, ok: processed.ok, result: reply.result });
  };
