import type libheif from "libheif-js/wasm-bundle.js";

export type DecodedHeic = { data: Buffer; width: number; height: number };

type Libheif = { module: typeof libheif; decoder: libheif.HeifDecoder };

let loading: Promise<Libheif> | undefined;

// A megabyte of wasm inside a base64 bundle: loaded on the first HEIC, not at
// boot. A failed load is not cached, so the next upload tries again.
const getLibheif = () =>
  (loading ??= import("libheif-js/wasm-bundle.js")
    .then(({ default: module }) => ({ module, decoder: new module.HeifDecoder() }))
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));

// The plane is a view into wasm memory and may carry row padding, so it is
// copied out row by row before the image is released.
const copyRows = (plane: libheif.HeifPlane): Buffer => {
  const rowBytes = plane.width * 4;
  const data = Buffer.allocUnsafe(rowBytes * plane.height);
  for (let row = 0; row < plane.height; row++) {
    const start = row * plane.stride;
    data.set(plane.data.subarray(start, start + rowBytes), row * rowBytes);
  }
  return data;
};

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const LARGE_SIZE_MARKER = 1;
const TO_END_OF_FILE = 0;

/**
 * Whether every top-level ISO-BMFF box lies inside the buffer. libheif 1.23.2
 * decodes a file whose boxes claim more bytes than arrived into a partly filled
 * bitmap and calls it a success, so a container that lies about its own length
 * is refused here rather than handed to the wasm parser.
 *
 * A box states its size one of three ways: in the 32-bit field itself, as a
 * 64-bit value after the type when that field holds 1, or implicitly to the end
 * of the file when it holds 0. The last form declares no extent, so truncation
 * of that box and anything after it is invisible to this walk.
 *
 * A tail too short to hold a box header is padding. A longer one has to parse
 * as a box, because nothing tells trailing data apart from a cut-off header.
 */
export const containerIsComplete = (bytes: Buffer): boolean => {
  let offset = 0;
  while (offset + BOX_HEADER_BYTES <= bytes.length) {
    const declared = bytes.readUInt32BE(offset);
    if (declared === TO_END_OF_FILE) return true;

    let size = declared;
    let headerBytes = BOX_HEADER_BYTES;
    if (declared === LARGE_SIZE_MARKER) {
      if (offset + LARGE_BOX_HEADER_BYTES > bytes.length) return false;
      const large = bytes.readBigUInt64BE(offset + BOX_HEADER_BYTES);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(large);
      headerBytes = LARGE_BOX_HEADER_BYTES;
    }

    if (size < headerBytes) return false;
    offset += size;
    if (offset > bytes.length) return false;
  }
  return true;
};

/**
 * The first image in a HEIC file as RGBA, upright, or undefined when the file is
 * truncated, will not decode or would exceed `maxPixels`. Throws only if the wasm
 * module aborts. Sharp's prebuilt libvips has no HEVC decoder, so this WebAssembly
 * libheif does the decoding instead. The wrapper's own `display()` is not used:
 * it decodes inside a timer, where a throw escapes every handler.
 */
export const decodeHeic = async (
  bytes: Buffer,
  maxPixels: number
): Promise<DecodedHeic | undefined> => {
  if (!containerIsComplete(bytes)) return undefined;
  const { module, decoder } = await getLibheif();
  // Synchronous from here: the shared decoder frees the previous file's
  // context on its next call, so nothing may interleave before the copy-out.
  const images = decoder.decode(bytes);
  const [image] = images;
  if (!image) return undefined;
  try {
    const width = image.get_width();
    const height = image.get_height();
    if (width * height > maxPixels) return undefined;
    const result = module.heif_js_decode_image2(
      image.handle,
      module.heif_colorspace.heif_colorspace_RGB,
      module.heif_chroma.heif_chroma_interleaved_RGBA
    );
    if (result.code !== undefined) return undefined;
    try {
      const plane = result.channels.find(
        (channel) => channel.id === module.heif_channel.heif_channel_interleaved
      );
      if (!plane || plane.width !== width || plane.height !== height) return undefined;
      return { data: copyRows(plane), width, height };
    } finally {
      module.heif_image_release(result.image);
    }
  } finally {
    for (const each of images) each.free();
  }
};
