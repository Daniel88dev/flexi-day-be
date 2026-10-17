import { describe, it, expect } from "vitest";
import { authSecretFingerprint } from "../authSecretServices.js";

const SECRET = "k3Jx9VqT2mWb8YfR5nLp1DcZ7sHg4AeU";

describe("authSecretFingerprint", () => {
  it("gives the same secret the same fingerprint on every boot", () => {
    expect(authSecretFingerprint(SECRET)).toBe(authSecretFingerprint(SECRET));
  });

  it("tells a rotated secret apart", () => {
    expect(authSecretFingerprint(`${SECRET}x`)).not.toBe(authSecretFingerprint(SECRET));
  });

  it("is a SHA-256 HMAC in hex and carries no part of the secret", () => {
    const fingerprint = authSecretFingerprint(SECRET);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain(SECRET.toLowerCase().slice(0, 8));
    expect(fingerprint).not.toContain(Buffer.from(SECRET).toString("hex").slice(0, 16));
  });
});
