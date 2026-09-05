import { createHmac, timingSafeEqual } from "node:crypto";

/** Carries the hex HMAC-SHA256 of the raw request body, keyed with the callback secret. */
export const ATTACHMENT_SIGNATURE_HEADER = "x-attachment-signature";

export const signAttachmentCallback = (secret: string, body: Buffer | string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

/** True only for the signature of exactly these bytes under this secret; constant-time. */
export const verifyAttachmentCallback = (
  secret: string,
  body: Buffer | string,
  signature: string | undefined
): boolean => {
  if (typeof signature !== "string") return false;
  const expected = Buffer.from(signAttachmentCallback(secret, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};
