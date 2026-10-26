import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3OrganizationDataStore } from "../organizationDataStore.js";

const store = createS3OrganizationDataStore({
  bucket: "flexi-day-test-organization-data",
  region: "eu-central-1",
  credentials: { accessKeyId: "AKIATESTKEY", secretAccessKey: "test-secret" },
});

const photoId = "0f6b6a1e-6b7e-4f6c-9e0a-1d2c3b4a5f60";
const storageKey = `photos/org-1/emp-1/${photoId}/`;

describe("S3 organization-data store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("presigns a photo POST to the incoming prefix that pins type, size and the photo's metadata", async () => {
    const target = await store.createPhotoUploadTarget({
      photoId,
      contentType: "image/heic",
      size: 4321,
      storageKey,
    });

    expect(target.method).toBe("POST");
    if (target.method !== "POST") return;
    expect(target.url).toBe(
      "https://flexi-day-test-organization-data.s3.eu-central-1.amazonaws.com/"
    );
    expect(target.fields.key).toBe(`incoming/${photoId}`);
    expect(target.fields["x-amz-meta-photo-id"]).toBe(photoId);
    expect(target.fields["x-amz-meta-storage-key"]).toBe(storageKey);
    const policy = JSON.parse(Buffer.from(target.fields.Policy!, "base64").toString()) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(["content-length-range", 1, 4321]);
    expect(policy.conditions).toContainEqual({ "Content-Type": "image/heic" });
    expect(policy.conditions).toContainEqual({ "x-amz-meta-photo-id": photoId });
  });

  it("hands out the same image link for a whole hour, valid for two hours from its start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T10:05:00Z"));
    const early = await store.createImageUrl(`${storageKey}small.jpg`);
    vi.setSystemTime(new Date("2026-10-26T10:55:00Z"));
    const late = await store.createImageUrl(`${storageKey}small.jpg`);
    vi.setSystemTime(new Date("2026-10-26T11:00:01Z"));
    const next = await store.createImageUrl(`${storageKey}small.jpg`);

    expect(late).toBe(early);
    expect(next).not.toBe(early);
    const parsed = new URL(early);
    expect(parsed.pathname).toBe(`/${storageKey}small.jpg`);
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20261026T100000Z");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("7200");
    expect(parsed.searchParams.get("response-cache-control")).toBe("private, max-age=3600");
  });
});
