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
    ["oversized-exif.heic", "image/heic"],
    ["clean.pdf", "application/pdf"],
  ])("recognises %s as %s", (name, expected) => {
    expect(sniffContentType(fixture(name))).toBe(expected);
  });

  it("returns undefined for bytes of no accepted type", () => {
    expect(sniffContentType(fixture("not-an-image.jpg"))).toBeUndefined();
    expect(sniffContentType(Buffer.alloc(0))).toBeUndefined();
  });

  it("does not take every ISO container for HEIC", () => {
    const mp4 = Buffer.from("\0\0\0\x18ftypisom\0\0\x02\0isomiso2mp41", "latin1");
    expect(sniffContentType(mp4)).toBeUndefined();
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

  it("decodes an oversized HEIC to a capped JPEG with no EXIF", async () => {
    const input = fixture("oversized-exif.heic");
    expect(input.includes("Exif")).toBe(true);

    const result = await processAttachment(input, "image/heic");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe("image/jpeg");
    expect(sniffContentType(result.bytes)).toBe("image/jpeg");
    expect(result.width).toBe(MAX_IMAGE_EDGE_PX);
    expect(result.height).toBe(MAX_IMAGE_EDGE_PX / 2);
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(result.bytes.includes("Exif")).toBe(false);
  });

  it("decodes two HEICs at once without mixing them up", async () => {
    const input = fixture("oversized-exif.heic");

    const results = await Promise.all([
      processAttachment(input, "image/heic"),
      processAttachment(input, "image/heic"),
      processAttachment(input.subarray(0, 4096), "image/heic"),
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true, false]);
    for (const result of results.slice(0, 2)) {
      if (!result.ok) continue;
      expect(result).toMatchObject({ width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX / 2 });
    }
  });

  it("rejects a HEIC whose container parses but whose picture data is cut off", async () => {
    const whole = fixture("oversized-exif.heic");
    const corrupt = whole.subarray(0, Math.floor(whole.length / 2));

    await expect(processAttachment(corrupt, "image/heic")).resolves.toEqual({
      ok: false,
      reason: AttachmentRejectionReason.ImageUnreadable,
    });
    await expect(processAttachment(whole.subarray(0, 64), "image/heic")).resolves.toEqual({
      ok: false,
      reason: AttachmentRejectionReason.ImageUnreadable,
    });
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
