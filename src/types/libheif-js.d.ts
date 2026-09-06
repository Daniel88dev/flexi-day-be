// The package ships typings for the raw Emscripten module only; the
// HeifDecoder wrapper its bundle entry points attach is untyped, and the
// decode result below is documented as `any`.
declare module "libheif-js/wasm-bundle.js" {
  namespace libheif {
    /** Embind enum members are singleton objects; compare them by identity. */
    type HeifEnumValue = object;
    type HeifImageHandle = object;
    type HeifImagePtr = object;

    interface HeifImage {
      handle: HeifImageHandle;
      get_width(): number;
      get_height(): number;
      free(): void;
    }

    class HeifDecoder {
      /** Every top-level image in the file; empty, not thrown, when the container will not parse. Frees the previous call's context. */
      decode(bytes: Uint8Array): HeifImage[];
    }

    interface HeifPlane {
      id: HeifEnumValue;
      width: number;
      height: number;
      /** Bytes per row, padding included. */
      stride: number;
      /** A view into wasm memory, valid until the image is released. */
      data: Uint8Array;
    }

    type HeifDecodeResult =
      | { code: HeifEnumValue; message: string }
      | { code?: undefined; image: HeifImagePtr; channels: HeifPlane[] };

    const heif_colorspace: { heif_colorspace_RGB: HeifEnumValue };
    const heif_chroma: { heif_chroma_interleaved_RGBA: HeifEnumValue };
    const heif_channel: { heif_channel_interleaved: HeifEnumValue };
    function heif_js_decode_image2(
      handle: HeifImageHandle,
      colorspace: HeifEnumValue,
      chroma: HeifEnumValue
    ): HeifDecodeResult;
    function heif_image_release(image: HeifImagePtr): void;
  }

  export = libheif;
}
