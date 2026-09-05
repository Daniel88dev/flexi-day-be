import { describe, expect, it } from "vitest";
import { createS3AttachmentStore } from "../s3AttachmentStore.js";

const store = createS3AttachmentStore({
  bucket: "flexi-day-test-attachments",
  region: "eu-central-1",
  credentials: { accessKeyId: "AKIATESTKEY", secretAccessKey: "test-secret" },
});

const attachmentId = "0f6b6a1e-6b7e-4f6c-9e0a-1d2c3b4a5f60";
const storageKey = `org-1/user-1/${attachmentId}`;

describe("S3 attachment store", () => {
  it("presigns a POST to the incoming prefix that pins type, size and the row's metadata", async () => {
    const before = Date.now();
    const target = await store.createUploadTarget({
      attachmentId,
      contentType: "image/png",
      size: 1234,
      storageKey,
    });

    expect(target.method).toBe("POST");
    if (target.method !== "POST") return;
    expect(target.url).toBe("https://flexi-day-test-attachments.s3.eu-central-1.amazonaws.com/");
    expect(target.fields.key).toBe(`incoming/${attachmentId}`);
    expect(target.fields["Content-Type"]).toBe("image/png");
    expect(target.fields["x-amz-meta-attachment-id"]).toBe(attachmentId);
    expect(target.fields["x-amz-meta-storage-key"]).toBe(storageKey);

    const policy = JSON.parse(Buffer.from(target.fields.Policy!, "base64").toString()) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(["content-length-range", 1, 1234]);
    expect(policy.conditions).toContainEqual({ "Content-Type": "image/png" });
    expect(policy.conditions).toContainEqual({ key: `incoming/${attachmentId}` });
    expect(policy.conditions).toContainEqual({ "x-amz-meta-storage-key": storageKey });

    // The policy's expiration is written to the second.
    const fiveMinutes = 5 * 60 * 1000;
    const expiration = new Date(policy.expiration).getTime();
    expect(expiration).toBeGreaterThanOrEqual(before + fiveMinutes - 1000);
    expect(expiration).toBeLessThan(before + fiveMinutes + 5000);
    expect(new Date(target.expiresAt).getTime()).toBeGreaterThanOrEqual(before + fiveMinutes);
  });

  it("presigns a one-minute GET carrying the disposition, file name and stored type", async () => {
    const { url, expiresAt } = await store.createDownloadUrl({
      attachmentId,
      storageKey: `${storageKey}.jpg`,
      fileName: "příloha.jpg",
      contentType: "image/jpeg",
      disposition: "attachment",
    });

    const parsed = new URL(url);
    expect(parsed.host).toBe("flexi-day-test-attachments.s3.eu-central-1.amazonaws.com");
    expect(parsed.pathname).toBe(`/${storageKey}.jpg`);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(parsed.searchParams.get("response-content-type")).toBe("image/jpeg");
    expect(parsed.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="p__loha.jpg"; filename*=UTF-8''${encodeURIComponent("příloha.jpg")}`
    );
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 60 * 1000);
  });
});
