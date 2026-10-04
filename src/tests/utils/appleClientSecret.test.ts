import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppleSecretMinter } from "../../utils/appleClientSecret.js";
import { appleCredentials, decodeJwtPart, newP256Key } from "../appleFixtures.js";

function verifiesAsEs256(jwt: string, publicKey: KeyObject) {
  const [header, payload, signature] = jwt.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature ?? "", "base64url")
  );
}

const T0 = new Date("2026-10-04T12:00:00Z");
const T0_SECONDS = T0.getTime() / 1000;

describe("createAppleSecretMinter", () => {
  const key = newP256Key();
  const apple = appleCredentials(key.pem);
  const minterFor = (privateKey = key.pem) =>
    createAppleSecretMinter({ teamId: apple.appleTeamId, keyId: apple.appleKeyId, privateKey });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs an ES256 JWT that verifies against the key's public half", () => {
    const secret = minterFor().secretFor("com.flexiday.web");

    expect(secret.split(".")).toHaveLength(3);
    expect(verifiesAsEs256(secret, key.publicKey)).toBe(true);
  });

  it("carries the header and claims Apple documents for a client secret", () => {
    const secret = minterFor().secretFor("com.flexiday.web");

    expect(decodeJwtPart(secret, 0)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decodeJwtPart(secret, 1)).toEqual({
      iss: "TEAM123456",
      sub: "com.flexiday.web",
      aud: "https://appleid.apple.com",
      iat: T0_SECONDS,
      exp: T0_SECONDS + 3600,
    });
  });

  it("does not verify against a different key", () => {
    const other = newP256Key();
    expect(verifiesAsEs256(minterFor().secretFor("com.flexiday.web"), other.publicKey)).toBe(false);
  });

  it("returns the cached secret while five minutes or more remain", () => {
    const minter = minterFor();
    const first = minter.secretFor("com.flexiday.web");

    vi.setSystemTime(T0.getTime() + 30 * 60 * 1000);
    expect(minter.secretFor("com.flexiday.web")).toBe(first);

    vi.setSystemTime(T0.getTime() + 55 * 60 * 1000);
    expect(minter.secretFor("com.flexiday.web")).toBe(first);
  });

  it("mints a fresh secret once under five minutes remain", () => {
    const minter = minterFor();
    const first = minter.secretFor("com.flexiday.web");

    vi.setSystemTime(T0.getTime() + (55 * 60 + 1) * 1000);
    const second = minter.secretFor("com.flexiday.web");

    expect(second).not.toBe(first);
    expect(decodeJwtPart(second, 1)).toMatchObject({
      iat: T0_SECONDS + 55 * 60 + 1,
      exp: T0_SECONDS + 55 * 60 + 1 + 3600,
    });
    expect(verifiesAsEs256(second, key.publicKey)).toBe(true);
  });

  it("keeps one secret per subject", () => {
    const minter = minterFor();
    const web = minter.secretFor("com.flexiday.web");
    const app = minter.secretFor("com.flexiday.app");

    expect(app).not.toBe(web);
    expect(decodeJwtPart(app, 1)).toMatchObject({ sub: "com.flexiday.app" });
    expect(minter.secretFor("com.flexiday.web")).toBe(web);
    expect(minter.secretFor("com.flexiday.app")).toBe(app);
  });

  it("accepts a PEM whose newlines arrive as literal \\n, as a .env line carries them", () => {
    const escaped = key.pem.trim().replaceAll("\n", "\\n");
    expect(escaped).not.toContain("\n");

    const secret = minterFor(escaped).secretFor("com.flexiday.web");
    expect(verifiesAsEs256(secret, key.publicKey)).toBe(true);
  });

  it("refuses a value that is not a private key, without echoing it", () => {
    expect(() => minterFor("not-a-key")).toThrow(/APPLE_PRIVATE_KEY/);
    expect(() => minterFor("not-a-key")).not.toThrow(/not-a-key/);
  });

  it("refuses a private key that cannot sign ES256", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    expect(() => minterFor(rsa)).toThrow(/APPLE_PRIVATE_KEY/);
    expect(() => minterFor(p384)).toThrow(/APPLE_PRIVATE_KEY/);
  });
});
