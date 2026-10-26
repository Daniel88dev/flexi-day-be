import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import type {
  IncomingObject,
  NotifyResult,
  ObjectStore,
  S3ObjectCreatedEvent,
} from "../handler.js";
import { routeByBucket } from "../handler.js";
import { createPhotoHandler } from "../photoHandler.js";
import type { PhotoProcessedPayload } from "../../../services/directory/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../services/attachment/tests/fixtures"
);
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name));

const photoId = "7a1c9f0e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const storageKey = `photos/org-1/emp-1/${photoId}/`;
const incoming = `incoming/${photoId}`;

const fakeStore = (objects: Record<string, IncomingObject>) => {
  const bucket = new Map(Object.entries(objects));
  const written: { key: string; bytes: Buffer; contentType: string }[] = [];
  const deleted: string[] = [];
  const store: ObjectStore = {
    get: (key) => Promise.resolve(bucket.get(key)),
    put: (key, bytes, contentType) => {
      if (written.some((w) => w.key === key)) return Promise.resolve(false);
      written.push({ key, bytes, contentType });
      return Promise.resolve(true);
    },
    delete: (key) => {
      bucket.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
  };
  return { store, written, deleted, has: (key: string) => bucket.has(key) };
};

const photo = (bytes: Buffer, contentType: string): IncomingObject => ({
  bytes,
  contentType,
  metadata: { "photo-id": photoId, "storage-key": storageKey },
});

const withGps = () =>
  sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#884422" } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "50/1 5/1 0/1" } })
    .toBuffer();

const run = async (
  objects: Record<string, IncomingObject>,
  result: NotifyResult = { result: "applied" }
) => {
  const bucket = fakeStore(objects);
  const reports: PhotoProcessedPayload[] = [];
  const notify = vi.fn((payload: PhotoProcessedPayload) => {
    reports.push(payload);
    return Promise.resolve(result);
  });
  await createPhotoHandler({ store: bucket.store, notify, log: () => undefined })(incoming);
  return { ...bucket, reports };
};

describe("attachment-processor, Profile photos", () => {
  it("stores a small and a full JPEG without metadata, reports READY and drops the incoming object", async () => {
    const { written, deleted, reports } = await run({
      [incoming]: photo(await withGps(), "image/jpeg"),
    });

    expect(written.map((w) => [w.key, w.contentType])).toEqual([
      [`${storageKey}small.jpg`, "image/jpeg"],
      [`${storageKey}full.jpg`, "image/jpeg"],
    ]);
    const [small, full] = await Promise.all(written.map((w) => sharp(w.bytes).metadata()));
    expect([small!.width, full!.width]).toEqual([256, 1024]);
    expect([small!.exif, full!.exif]).toEqual([undefined, undefined]);
    expect(reports).toEqual([{ photoId, status: "READY" }]);
    expect(deleted).toEqual([incoming]);
  });

  it("reports a rejection, writes nothing and drops the incoming object", async () => {
    const { written, deleted, reports } = await run({
      [incoming]: photo(fixture("clean.pdf"), "application/pdf"),
    });

    expect(written).toEqual([]);
    expect(reports).toEqual([{ photoId, status: "REJECTED", rejectionReason: "TYPE_MISMATCH" }]);
    expect(deleted).toEqual([incoming]);
  });

  it("deletes both sizes when the API says the photo is gone", async () => {
    const { deleted } = await run(
      { [incoming]: photo(fixture("small.png"), "image/png") },
      {
        result: "gone",
      }
    );

    expect(deleted).toEqual([`${storageKey}small.jpg`, `${storageKey}full.jpg`, incoming]);
  });

  it("deletes a fresh write onto a photo already settled REJECTED, and keeps one settled READY", async () => {
    const rejected = await run(
      { [incoming]: photo(fixture("small.png"), "image/png") },
      {
        result: "already",
        row: { status: "REJECTED", contentType: null },
      }
    );
    expect(rejected.deleted).toEqual([`${storageKey}small.jpg`, `${storageKey}full.jpg`, incoming]);

    const ready = await run(
      { [incoming]: photo(fixture("small.png"), "image/png") },
      {
        result: "already",
        row: { status: "READY", contentType: null },
      }
    );
    expect(ready.deleted).toEqual([incoming]);
  });

  it("drops an object with no photo metadata without reporting", async () => {
    const { reports, deleted } = await run({
      [incoming]: { bytes: fixture("small.png"), contentType: "image/png", metadata: {} },
    });

    expect(reports).toEqual([]);
    expect(deleted).toEqual([incoming]);
  });
});

describe("routeByBucket", () => {
  const record = (bucket: string, key: string) => ({
    s3: { bucket: { name: bucket }, object: { key } },
  });

  it("sends attachment events to the attachment path and the rest to the photo path of their bucket", async () => {
    const attachments = vi.fn((_event: S3ObjectCreatedEvent) => Promise.resolve());
    const photoKeys: [string, string][] = [];
    const handler = routeByBucket({
      attachmentsBucket: "attachments",
      attachments,
      photos: (bucket) => (key) => {
        photoKeys.push([bucket, key]);
        return Promise.resolve();
      },
    });

    await handler({
      Records: [
        record("attachments", "incoming/one"),
        record("organization-data", "incoming/a+b%2Bc"),
      ],
    });

    expect(attachments).toHaveBeenCalledWith({ Records: [record("attachments", "incoming/one")] });
    expect(photoKeys).toEqual([["organization-data", "incoming/a b+c"]]);
  });
});
