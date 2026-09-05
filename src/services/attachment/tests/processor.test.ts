import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import {
  AttachmentRejectionReason,
  MAX_IMAGE_EDGE_PX,
  processAttachment,
  sniffContentType,
} from "../processor.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name));

describe("sniffContentType", () => {
  it.each([
    ["small.png", "image/png"],
    ["small.webp", "image/webp"],
    ["oversized-exif.jpg", "image/jpeg"],
    ["clean.pdf", "application/pdf"],
  ])("recognises %s as %s", (name, expected) => {
    expect(sniffContentType(fixture(name))).toBe(expected);
  });

  it("returns undefined for bytes that are none of the four types", () => {
    expect(sniffContentType(fixture("not-an-image.jpg"))).toBeUndefined();
    expect(sniffContentType(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("processAttachment", () => {
  it("rewrites a PNG to JPEG", async () => {
    const result = await processAttachment(fixture("small.png"), "image/png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe("image/jpeg");
    expect(sniffContentType(result.bytes)).toBe("image/jpeg");
    expect(result).toMatchObject({ width: 64, height: 48 });
  });

  it("rewrites a WebP to JPEG", async () => {
    const result = await processAttachment(fixture("small.webp"), "image/webp");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sniffContentType(result.bytes)).toBe("image/jpeg");
    expect(result).toMatchObject({ width: 80, height: 40 });
  });

  it("caps an oversized JPEG at the long-edge limit and strips its EXIF", async () => {
    const input = fixture("oversized-exif.jpg");
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processAttachment(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(MAX_IMAGE_EDGE_PX);
    expect(result.height).toBe(MAX_IMAGE_EDGE_PX / 2);
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBe(MAX_IMAGE_EDGE_PX);
  });

  it("keeps a clean PDF byte for byte", async () => {
    const input = fixture("clean.pdf");

    const result = await processAttachment(input, "application/pdf");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe("application/pdf");
    expect(result.bytes.equals(input)).toBe(true);
    expect(result.width).toBeNull();
  });

  it.each([
    ["javascript.pdf", AttachmentRejectionReason.PdfJavaScript],
    ["launch.pdf", AttachmentRejectionReason.PdfLaunchAction],
    ["encrypted.pdf", AttachmentRejectionReason.PdfEncrypted],
  ])("rejects %s with %s", async (name, reason) => {
    const result = await processAttachment(fixture(name), "application/pdf");

    expect(result).toEqual({ ok: false, reason });
  });

  it("rejects bytes that do not match the claimed type", async () => {
    await expect(processAttachment(fixture("not-an-image.jpg"), "image/jpeg")).resolves.toEqual({
      ok: false,
      reason: AttachmentRejectionReason.TypeMismatch,
    });
    await expect(processAttachment(fixture("small.png"), "image/jpeg")).resolves.toEqual({
      ok: false,
      reason: AttachmentRejectionReason.TypeMismatch,
    });
    await expect(processAttachment(fixture("clean.pdf"), "image/png")).resolves.toEqual({
      ok: false,
      reason: AttachmentRejectionReason.TypeMismatch,
    });
  });

  it("rejects an image whose header is right but whose body will not decode", async () => {
    const truncated = fixture("oversized-exif.jpg").subarray(0, 64);

    await expect(processAttachment(truncated, "image/jpeg")).resolves.toEqual({
      ok: false,
      reason: AttachmentRejectionReason.ImageUnreadable,
    });
  });
});
