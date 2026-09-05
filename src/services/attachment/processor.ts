import sharp, { type Sharp } from "sharp";
import { decodeHeic } from "./heic.js";

export const ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

export const MAX_IMAGE_EDGE_PX = 2048;

// A decompression bomb is the one thing sharp will not refuse on its own.
const MAX_INPUT_PIXELS = 40_000_000;

export enum AttachmentRejectionReason {
  TypeMismatch = "TYPE_MISMATCH",
  ImageUnreadable = "IMAGE_UNREADABLE",
  PdfJavaScript = "PDF_JAVASCRIPT",
  PdfLaunchAction = "PDF_LAUNCH_ACTION",
  PdfEncrypted = "PDF_ENCRYPTED",
}

export type ProcessedAttachment =
  | {
      ok: true;
      bytes: Buffer;
      contentType: "image/jpeg" | "application/pdf";
      width: number | null;
      height: number | null;
    }
  | { ok: false; reason: AttachmentRejectionReason };

export const isAttachmentContentType = (value: string): value is AttachmentContentType =>
  (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value);

const startsWith = (bytes: Buffer, magic: number[] | string, offset = 0): boolean => {
  const expected = typeof magic === "string" ? Buffer.from(magic, "latin1") : Buffer.from(magic);
  return (
    bytes.length >= offset + expected.length &&
    bytes.subarray(offset, offset + expected.length).equals(expected)
  );
};

// Major brands that promise HEVC inside the ISO container; iPhones write
// `heic`. The generic `mif1` is left out: it may wrap AVIF, which this
// decoder cannot read, and the verdict for that should stay TYPE_MISMATCH.
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx"];

/** The type the bytes actually are, from their magic numbers; undefined for anything else. */
export const sniffContentType = (bytes: Buffer): AttachmentContentType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, "ftyp", 4) && HEIC_BRANDS.some((brand) => startsWith(bytes, brand, 8))) {
    return "image/heic";
  }
  if (startsWith(bytes, "%PDF-")) return "application/pdf";
  return undefined;
};

// A name token ends at any delimiter, so `/JS` must not match `/JSx`.
const pdfMarker = (name: string) => new RegExp(`/${name}(?![A-Za-z0-9_])`);
const PDF_REJECTIONS: [RegExp, AttachmentRejectionReason][] = [
  [pdfMarker("JavaScript"), AttachmentRejectionReason.PdfJavaScript],
  [pdfMarker("JS"), AttachmentRejectionReason.PdfJavaScript],
  [pdfMarker("Launch"), AttachmentRejectionReason.PdfLaunchAction],
  [pdfMarker("Encrypt"), AttachmentRejectionReason.PdfEncrypted],
];

const processPdf = (bytes: Buffer): ProcessedAttachment => {
  const text = bytes.toString("latin1");
  for (const [marker, reason] of PDF_REJECTIONS) {
    if (marker.test(text)) return { ok: false, reason };
  }
  return { ok: true, bytes, contentType: "application/pdf", width: null, height: null };
};

const toJpeg = async (input: Sharp): Promise<ProcessedAttachment> => {
  try {
    // `rotate()` bakes the EXIF orientation in before the metadata is dropped;
    // sharp strips EXIF, ICC and XMP unless asked to keep them.
    const { data, info } = await input
      .rotate()
      .resize({
        width: MAX_IMAGE_EDGE_PX,
        height: MAX_IMAGE_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      bytes: data,
      contentType: "image/jpeg",
      width: info.width,
      height: info.height,
    };
  } catch {
    return { ok: false, reason: AttachmentRejectionReason.ImageUnreadable };
  }
};

const processImage = (bytes: Buffer) =>
  toJpeg(sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }));

// libheif applies the file's rotation and mirroring itself, so the bitmap
// arrives upright and carries no metadata for sharp to strip.
const processHeic = async (bytes: Buffer): Promise<ProcessedAttachment> => {
  const decoded = await decodeHeic(bytes, MAX_INPUT_PIXELS).catch(() => undefined);
  if (!decoded) return { ok: false, reason: AttachmentRejectionReason.ImageUnreadable };
  const { data, width, height } = decoded;
  return toJpeg(sharp(data, { raw: { width, height, channels: 4 } }));
};

/**
 * Bytes and a claimed type in, bytes and a verdict out. Shared by the disk
 * store and the `attachment-processor` Lambda (docs/adr/0003), so it touches
 * neither the database nor the store.
 */
export const processAttachment = async (
  bytes: Buffer,
  claimedType: AttachmentContentType
): Promise<ProcessedAttachment> => {
  if (sniffContentType(bytes) !== claimedType) {
    return { ok: false, reason: AttachmentRejectionReason.TypeMismatch };
  }
  if (claimedType === "application/pdf") return processPdf(bytes);
  return claimedType === "image/heic" ? processHeic(bytes) : processImage(bytes);
};
