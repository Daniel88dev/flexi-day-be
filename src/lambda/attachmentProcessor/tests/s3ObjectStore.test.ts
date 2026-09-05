import { describe, expect, it, vi } from "vitest";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createS3ObjectStore } from "../s3ObjectStore.js";

const s3Error = (name: string, httpStatusCode: number) =>
  new S3ServiceException({ name, $fault: "client", $metadata: { httpStatusCode } });

const setup = (send: (command: unknown) => Promise<unknown>) => {
  const client = { send: vi.fn(send) };
  return { client, store: createS3ObjectStore(client as unknown as S3Client, "bucket") };
};

describe("Lambda S3 object store", () => {
  it("reads the bytes, the pinned type and the row metadata", async () => {
    const { client, store } = setup(() =>
      Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
        ContentType: "image/png",
        Metadata: { "attachment-id": "a-1", "storage-key": "org/user/a-1" },
      })
    );

    const object = await store.get("incoming/a-1");

    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(object).toEqual({
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/png",
      metadata: { "attachment-id": "a-1", "storage-key": "org/user/a-1" },
    });
  });

  it("reads a missing key as gone and lets any other failure through", async () => {
    const gone = setup(() =>
      Promise.reject(new NoSuchKey({ message: "gone", $metadata: { httpStatusCode: 404 } }))
    );
    await expect(gone.store.get("incoming/a-1")).resolves.toBeUndefined();

    const denied = setup(() => Promise.reject(s3Error("AccessDenied", 403)));
    await expect(denied.store.get("incoming/a-1")).rejects.toThrow();
  });

  it("writes only when the key is new, and treats an existing object as already written", async () => {
    const fresh = setup(() => Promise.resolve({}));
    await expect(
      fresh.store.put("org/user/a-1.jpg", Buffer.from("jpg"), "image/jpeg")
    ).resolves.toBe(true);
    const command = fresh.client.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "bucket",
      Key: "org/user/a-1.jpg",
      ContentType: "image/jpeg",
      IfNoneMatch: "*",
    });

    const taken = setup(() => Promise.reject(s3Error("PreconditionFailed", 412)));
    await expect(
      taken.store.put("org/user/a-1.jpg", Buffer.from("other"), "image/jpeg")
    ).resolves.toBe(false);

    const broken = setup(() => Promise.reject(s3Error("InternalError", 500)));
    await expect(
      broken.store.put("org/user/a-1.jpg", Buffer.from("jpg"), "image/jpeg")
    ).rejects.toThrow();
  });

  it("deletes by key", async () => {
    const { client, store } = setup(() => Promise.resolve({}));
    await store.delete("incoming/a-1");
    const command = client.send.mock.calls[0]?.[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: "bucket", Key: "incoming/a-1" });
  });
});
