import sharp from "sharp";

export const ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
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

/** The type the bytes actually are, from their magic numbers; undefined for anything else. */
export const sniffContentType = (bytes: Buffer): AttachmentContentType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
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

const processImage = async (bytes: Buffer): Promise<ProcessedAttachment> => {
  try {
    // `rotate()` bakes the EXIF orientation in before the metadata is dropped;
    // sharp strips EXIF, ICC and XMP unless asked to keep them.
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
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
  return claimedType === "application/pdf" ? processPdf(bytes) : processImage(bytes);
};
