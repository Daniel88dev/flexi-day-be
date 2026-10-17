import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/** Parses an Apple `.p8`, with real newlines or the literal `\n` a `.env` line carries. */
export function parseEs256PrivateKey(pem: string, variable: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.trim().replaceAll("\\n", "\n"));
  } catch {
    throw new Error(`${variable} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`${variable} is not an EC P-256 key, so it cannot sign ES256`);
  }
  return key;
}

const encodeJwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signEs256Jwt(key: KeyObject, keyId: string, claims: object): string {
  const signingInput = `${encodeJwtPart({ alg: "ES256", kid: keyId })}.${encodeJwtPart(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}
