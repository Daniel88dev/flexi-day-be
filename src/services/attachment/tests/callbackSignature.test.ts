import { describe, expect, it } from "vitest";
import { signAttachmentCallback, verifyAttachmentCallback } from "../callbackSignature.js";

const secret = "a-long-shared-secret";
const body = JSON.stringify({ attachmentId: "abc", status: "READY" });

describe("attachment callback signature", () => {
  it("verifies what it signed, for a string and for the same bytes as a Buffer", () => {
    const signature = signAttachmentCallback(secret, body);
    expect(verifyAttachmentCallback(secret, body, signature)).toBe(true);
    expect(verifyAttachmentCallback(secret, Buffer.from(body), signature)).toBe(true);
  });

  it("refuses a changed body, another secret, a truncated signature and a missing header", () => {
    const signature = signAttachmentCallback(secret, body);
    expect(verifyAttachmentCallback(secret, body + " ", signature)).toBe(false);
    expect(verifyAttachmentCallback("other-secret", body, signature)).toBe(false);
    expect(verifyAttachmentCallback(secret, body, signature.slice(0, -1))).toBe(false);
    expect(verifyAttachmentCallback(secret, body, undefined)).toBe(false);
  });
});
