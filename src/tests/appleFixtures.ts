import { generateKeyPairSync } from "node:crypto";

/** A throwaway EC P-256 key, the curve Apple's `.p8` keys use. */
export function newP256Key() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

/** All five Apple values `buildSocialProviders` needs, signed by a fresh key unless one is given. */
export function appleCredentials(privateKey = newP256Key().pem) {
  return {
    appleClientId: "com.flexiday.web",
    appleTeamId: "TEAM123456",
    appleKeyId: "KEY1234567",
    appleAppBundleIdentifier: "com.flexiday.app",
    applePrivateKey: privateKey,
  };
}

/** Decodes a JWT's header (`0`) or payload (`1`) without checking the signature. */
export function decodeJwtPart(jwt: string | undefined, part: 0 | 1): Record<string, unknown> {
  const encoded = jwt?.split(".")[part] ?? "";
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}
