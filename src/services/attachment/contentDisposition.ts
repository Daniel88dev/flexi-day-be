import type { AttachmentDisposition } from "./types.js";

// RFC 8187 leaves fewer characters bare than encodeURIComponent does.
const encodeExtValue = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

// RFC 6266: an ASCII fallback for old clients plus the UTF-8 form for everyone else.
export const contentDisposition = (
  disposition: AttachmentDisposition,
  fileName: string
): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeExtValue(fileName)}`;
};
