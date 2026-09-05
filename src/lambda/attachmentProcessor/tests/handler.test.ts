import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createHandler,
  type IncomingObject,
  type NotifyResult,
  type ObjectStore,
} from "../handler.js";
import { sniffContentType } from "../../../services/attachment/processor.js";
import type { AttachmentProcessedPayload } from "../../../services/attachment/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../services/attachment/tests/fixtures"
);
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name));

const attachmentId = "0f6b6a1e-6b7e-4f6c-9e0a-1d2c3b4a5f60";
const storageKey = `org-1/user-1/${attachmentId}`;
const incoming = `incoming/${attachmentId}`;

const event = (key = incoming) => ({ Records: [{ s3: { object: { key } } }] });

/** A bucket in a Map, remembering what was written and deleted. */
const fakeStore = (objects: Record<string, IncomingObject>) => {
  const bucket = new Map(Object.entries(objects));
  const written: { key: string; bytes: Buffer; contentType: string }[] = [];
  const deleted: string[] = [];
  const store: ObjectStore = {
    get: (key) => Promise.resolve(bucket.get(key)),
    put: (key, bytes, contentType) => {
      // Like S3 under IfNoneMatch: the first write of a key wins.
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

const upload = (name: string, contentType: string): IncomingObject => ({
  bytes: fixture(name),
  contentType,
  metadata: { "attachment-id": attachmentId, "storage-key": storageKey },
});

const run = async (
  objects: Record<string, IncomingObject>,
  key?: string,
  result: NotifyResult = "applied",
  bucket = fakeStore(objects)
) => {
  const reports: AttachmentProcessedPayload[] = [];
  const notify = vi.fn((payload: AttachmentProcessedPayload) => {
    reports.push(payload);
    return Promise.resolve(result);
  });
  await createHandler({ store: bucket.store, notify, log: () => undefined })(event(key));
  return { ...bucket, reports, notify };
};

describe("attachment-processor handler", () => {
  it("stores an accepted image as JPEG under the final key, reports READY and drops the incoming object", async () => {
    const { written, deleted, has, reports } = await run({
      [incoming]: upload("small.png", "image/png"),
    });

    expect(written).toHaveLength(1);
    expect(written[0]!.key).toBe(`${storageKey}.jpg`);
    expect(written[0]!.contentType).toBe("image/jpeg");
    expect(sniffContentType(written[0]!.bytes)).toBe("image/jpeg");
    expect(reports).toEqual([
      {
        attachmentId,
        status: "READY",
        contentType: "image/jpeg",
        size: written[0]!.bytes.length,
      },
    ]);
    expect(deleted).toEqual([incoming]);
    expect(has(incoming)).toBe(false);
  });

  it("keeps a clean PDF as is under a .pdf key", async () => {
    const { written, reports } = await run({
      [incoming]: upload("clean.pdf", "application/pdf"),
    });

    expect(written[0]!.key).toBe(`${storageKey}.pdf`);
    expect(written[0]!.bytes.equals(fixture("clean.pdf"))).toBe(true);
    expect(reports[0]).toMatchObject({ status: "READY", contentType: "application/pdf" });
  });

  it("reports the rejection reason, writes nothing, and still drops the incoming object", async () => {
    const { written, deleted, reports } = await run({
      [incoming]: upload("not-an-image.jpg", "image/jpeg"),
    });

    expect(written).toHaveLength(0);
    expect(reports).toEqual([
      { attachmentId, status: "REJECTED", rejectionReason: "TYPE_MISMATCH" },
    ]);
    expect(deleted).toEqual([incoming]);
  });

  it("rejects a PDF with active content and a claimed type the processor does not know", async () => {
    const javascript = await run({ [incoming]: upload("javascript.pdf", "application/pdf") });
    expect(javascript.reports[0]).toMatchObject({ rejectionReason: "PDF_JAVASCRIPT" });

    const unknown = await run({ [incoming]: upload("small.png", "image/gif") });
    expect(unknown.reports[0]).toMatchObject({ rejectionReason: "TYPE_MISMATCH" });
    expect(unknown.deleted).toEqual([incoming]);
  });

  it("reads the URL-encoded key S3 puts in the event", async () => {
    const key = "incoming/a b+c";
    const { reports, deleted } = await run(
      { [key]: upload("small.png", "image/png") },
      "incoming/a+b%2Bc"
    );

    expect(reports).toHaveLength(1);
    expect(deleted).toEqual([key]);
  });

  it("does nothing for an object that is already gone", async () => {
    const { reports, deleted } = await run({});

    expect(reports).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("drops an object that carries no row metadata without reporting", async () => {
    const { reports, deleted, written } = await run({
      [incoming]: { bytes: fixture("small.png"), contentType: "image/png", metadata: {} },
    });

    expect(reports).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(deleted).toEqual([incoming]);
  });

  it("drops the object it wrote when the API says the row is gone", async () => {
    const { written, deleted } = await run(
      { [incoming]: upload("small.png", "image/png") },
      undefined,
      "gone"
    );

    expect(written[0]!.key).toBe(`${storageKey}.jpg`);
    expect(deleted).toEqual([`${storageKey}.jpg`, incoming]);
  });

  it("drops a fresh write the API would not take, a second post onto a settled row", async () => {
    const { written, deleted } = await run(
      { [incoming]: upload("small.png", "image/png") },
      undefined,
      "already"
    );

    expect(written[0]!.key).toBe(`${storageKey}.jpg`);
    expect(deleted).toEqual([`${storageKey}.jpg`, incoming]);
  });

  it("keeps the first object when a retry's write was a no-op and the row is settled", async () => {
    const bucket = fakeStore({ [incoming]: upload("small.png", "image/png") });
    await bucket.store.put(`${storageKey}.jpg`, Buffer.from("first"), "image/jpeg");

    const { written, deleted } = await run({}, undefined, "already", bucket);

    expect(written).toHaveLength(1);
    expect(written[0]!.bytes.toString()).toBe("first");
    expect(deleted).toEqual([incoming]);
  });

  it("leaves the incoming object in place when the report does not land, so a retry repeats the step", async () => {
    const bucket = fakeStore({ [incoming]: upload("small.png", "image/png") });
    const handler = createHandler({
      store: bucket.store,
      notify: () => Promise.reject(new Error("API unreachable")),
      log: () => undefined,
    });

    await expect(handler(event())).rejects.toThrow("API unreachable");
    expect(bucket.has(incoming)).toBe(true);
    expect(bucket.deleted).toHaveLength(0);
  });
});
