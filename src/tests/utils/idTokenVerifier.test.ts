import type { JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appleIdTokenVerifier,
  createIdTokenVerifier,
  googleIdTokenVerifier,
  microsoftIdTokenVerifier,
} from "../../utils/idTokenVerifier.js";
import {
  newSigningKey,
  sha256Hex,
  signIdToken,
  stubKeySet,
  type TestSigningKey,
} from "../idTokenFixtures.js";

const T0 = new Date("2026-10-04T12:00:00Z");
const T0_SECONDS = T0.getTime() / 1000;

const KEYS_URL = "https://keys.example.test/jwks";
const ISSUER = "https://issuer.example.test";
const AUDIENCE = "client-id";

let key: TestSigningKey;
let rotated: TestSigningKey;
let stranger: TestSigningKey;
let ecKey: TestSigningKey;

beforeAll(async () => {
  key = await newSigningKey("key-1");
  rotated = await newSigningKey("key-2");
  // Same kid as `key`, different key material: a forgery that names a real key.
  stranger = await newSigningKey("key-1");
  ecKey = await newSigningKey("ec-1", "ES256");
});

let served: JWK[];
let fetchMock: ReturnType<typeof stubKeySet>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  served = [key.jwk];
  fetchMock = stubKeySet(KEYS_URL, served);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "subject",
  ...extra,
});

describe("createIdTokenVerifier", () => {
  const verifierFor = (extra: Partial<Parameters<typeof createIdTokenVerifier>[0]> = {}) =>
    createIdTokenVerifier({ keysUrl: KEYS_URL, issuer: ISSUER, audience: AUDIENCE, ...extra });

  it("accepts a token signed by a key the provider publishes", async () => {
    expect(await verifierFor()(await signIdToken(key, claims()))).toBe(true);
  });

  it.each([
    ["another audience", { aud: "someone-else" }],
    ["another issuer", { iss: "https://evil.example.test" }],
    ["an expired token", { iat: T0_SECONDS - 7200, exp: T0_SECONDS - 60 }],
    ["a token older than an hour that has not expired", { iat: T0_SECONDS - 3700 }],
    ["a token with no issued-at", { iat: undefined }],
  ])("rejects %s", async (_label, extra) => {
    expect(await verifierFor()(await signIdToken(key, claims(extra)))).toBe(false);
  });

  it("rejects a token whose signature does not match the published key", async () => {
    expect(await verifierFor()(await signIdToken(stranger, claims()))).toBe(false);
  });

  it("rejects any algorithm but RS256, even from a published key", async () => {
    served.push(ecKey.jwk);
    expect(await verifierFor()(await signIdToken(ecKey, claims()))).toBe(false);
  });

  it("rejects something that is not a JWT without fetching keys", async () => {
    expect(await verifierFor()("not-a-token")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects rather than throws when the key set cannot be fetched", async () => {
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    expect(await verifierFor()(await signIdToken(key, claims()))).toBe(false);
  });

  describe("nonce", () => {
    it("is compared when the request carries one", async () => {
      const token = await signIdToken(key, claims({ nonce: "n-1" }));
      expect(await verifierFor()(token, "n-1")).toBe(true);
      expect(await verifierFor()(token, "n-2")).toBe(false);
    });

    it("rejects a requested nonce the token does not carry", async () => {
      expect(await verifierFor()(await signIdToken(key, claims()), "n-1")).toBe(false);
    });

    it("is not required when the request carries none", async () => {
      expect(await verifierFor()(await signIdToken(key, claims({ nonce: "n-1" })))).toBe(true);
    });

    it("accepts the nonce's SHA-256 only when the rules allow it", async () => {
      const token = await signIdToken(key, claims({ nonce: sha256Hex("n-1") }));
      expect(await verifierFor()(token, "n-1")).toBe(false);
      expect(await verifierFor({ nonceComparison: "exact-or-sha256" })(token, "n-1")).toBe(true);
    });
  });

  it("applies the provider's own claim rule last", async () => {
    const verify = verifierFor({ verifyClaims: (payload) => payload.sub === "allowed" });
    expect(await verify(await signIdToken(key, claims({ sub: "allowed" })))).toBe(true);
    expect(await verify(await signIdToken(key, claims({ sub: "other" })))).toBe(false);
  });

  describe("key cache", () => {
    it("fetches the key set once for two verifications", async () => {
      const verify = verifierFor();
      expect(await verify(await signIdToken(key, claims()))).toBe(true);
      expect(await verify(await signIdToken(key, claims()))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("shares one fetch between verifications that arrive together", async () => {
      const verify = verifierFor();
      const token = await signIdToken(key, claims());
      expect(await Promise.all([verify(token), verify(token), verify(token)])).toEqual([
        true,
        true,
        true,
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refetches once for a key id it has not seen, and accepts the rotated key", async () => {
      const verify = verifierFor();
      await verify(await signIdToken(key, claims()));
      served.push(rotated.jwk);
      vi.setSystemTime(T0.getTime() + 31_000);

      expect(await verify(await signIdToken(rotated, claims()))).toBe(true);
      expect(await verify(await signIdToken(rotated, claims()))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not refetch for an unknown key id inside the cooldown", async () => {
      const verify = verifierFor();
      await verify(await signIdToken(key, claims()));
      served.push(rotated.jwk);

      expect(await verify(await signIdToken(rotated, claims()))).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refetches once the cached set has aged out", async () => {
      const verify = verifierFor();
      await verify(await signIdToken(key, claims()));
      vi.setSystemTime(T0.getTime() + 11 * 60_000);

      expect(await verify(await signIdToken(key, claims()))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("googleIdTokenVerifier", () => {
  const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";

  beforeEach(() => {
    fetchMock = stubKeySet(GOOGLE_KEYS, served);
  });

  it.each(["https://accounts.google.com", "accounts.google.com"])(
    "accepts the issuer %s with the web client id as audience",
    async (iss) => {
      const token = await signIdToken(key, { iss, aud: "web-client", sub: "s" });
      expect(await googleIdTokenVerifier("web-client")(token)).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(GOOGLE_KEYS, expect.anything());
    }
  );

  it("rejects another issuer or audience", async () => {
    const verify = googleIdTokenVerifier("web-client");
    const iss = "https://accounts.google.com";
    expect(await verify(await signIdToken(key, { iss: ISSUER, aud: "web-client" }))).toBe(false);
    expect(await verify(await signIdToken(key, { iss, aud: "ios-client" }))).toBe(false);
  });

  it("compares a nonce exactly", async () => {
    const iss = "https://accounts.google.com";
    const token = await signIdToken(key, { iss, aud: "web-client", nonce: sha256Hex("n-1") });
    expect(await googleIdTokenVerifier("web-client")(token, "n-1")).toBe(false);
  });
});

describe("microsoftIdTokenVerifier", () => {
  const AUTHORITY = "https://login.microsoftonline.com";
  const WORK_TID = "11111111-1111-1111-1111-111111111111";
  const OTHER_TID = "22222222-2222-2222-2222-222222222222";
  const CONSUMER_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const tokenFrom = (tid: string | undefined, iss = `${AUTHORITY}/${tid}/v2.0`) =>
    signIdToken(key, { iss, aud: "ms-client", sub: "s", ...(tid ? { tid } : {}) });

  it.each(["common", WORK_TID, "organizations", "consumers"])(
    "reads the %s tenant's own key set",
    async (tenant) => {
      const url = `${AUTHORITY}/${tenant}/discovery/v2.0/keys`;
      fetchMock = stubKeySet(url, served);
      const tid = tenant === "consumers" ? CONSUMER_TID : WORK_TID;
      expect(await microsoftIdTokenVerifier("ms-client", tenant)(await tokenFrom(tid))).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(url, expect.anything());
    }
  );

  describe("on common", () => {
    beforeEach(() => {
      fetchMock = stubKeySet(`${AUTHORITY}/common/discovery/v2.0/keys`, served);
    });
    const verify = (token: string) => microsoftIdTokenVerifier("ms-client", "common")(token);

    it("accepts a work and a personal account whose issuer names their own tenant", async () => {
      expect(await verify(await tokenFrom(WORK_TID))).toBe(true);
      expect(await verify(await tokenFrom(CONSUMER_TID))).toBe(true);
    });

    it("rejects an issuer naming another tenant than the token's tid", async () => {
      expect(await verify(await tokenFrom(WORK_TID, `${AUTHORITY}/${OTHER_TID}/v2.0`))).toBe(false);
    });

    it("rejects a token without a tid", async () => {
      expect(await verify(await tokenFrom(undefined, `${AUTHORITY}/${WORK_TID}/v2.0`))).toBe(false);
    });

    it("rejects another audience", async () => {
      const iss = `${AUTHORITY}/${WORK_TID}/v2.0`;
      const token = await signIdToken(key, { iss, aud: "other", tid: WORK_TID });
      expect(await verify(token)).toBe(false);
    });
  });

  it("verifies against keys published without an alg, as Microsoft's are", async () => {
    const { alg: _alg, ...withoutAlg } = key.jwk;
    served.splice(0, served.length, withoutAlg);
    fetchMock = stubKeySet(`${AUTHORITY}/common/discovery/v2.0/keys`, served);
    expect(await microsoftIdTokenVerifier("ms-client", "common")(await tokenFrom(WORK_TID))).toBe(
      true
    );
  });

  it("pins a configured tenant to its own tokens", async () => {
    fetchMock = stubKeySet(`${AUTHORITY}/${WORK_TID}/discovery/v2.0/keys`, served);
    const verify = microsoftIdTokenVerifier("ms-client", WORK_TID);
    expect(await verify(await tokenFrom(WORK_TID))).toBe(true);
    expect(await verify(await tokenFrom(OTHER_TID))).toBe(false);
  });

  it("keeps personal accounts out of organizations and work accounts out of consumers", async () => {
    fetchMock = stubKeySet(`${AUTHORITY}/organizations/discovery/v2.0/keys`, served);
    expect(
      await microsoftIdTokenVerifier("ms-client", "organizations")(await tokenFrom(CONSUMER_TID))
    ).toBe(false);

    fetchMock = stubKeySet(`${AUTHORITY}/consumers/discovery/v2.0/keys`, served);
    expect(
      await microsoftIdTokenVerifier("ms-client", "consumers")(await tokenFrom(WORK_TID))
    ).toBe(false);
  });
});

describe("appleIdTokenVerifier", () => {
  const APPLE = "https://appleid.apple.com";

  beforeEach(() => {
    fetchMock = stubKeySet(`${APPLE}/auth/keys`, served);
  });

  it("accepts Apple's issuer with the bundle id as audience", async () => {
    const token = await signIdToken(key, { iss: APPLE, aud: "com.flexiday.app", sub: "s" });
    expect(await appleIdTokenVerifier("com.flexiday.app")(token)).toBe(true);
  });

  it("rejects the Services ID as audience and any other issuer", async () => {
    const verify = appleIdTokenVerifier("com.flexiday.app");
    expect(await verify(await signIdToken(key, { iss: APPLE, aud: "com.flexiday.web" }))).toBe(
      false
    );
    expect(await verify(await signIdToken(key, { iss: ISSUER, aud: "com.flexiday.app" }))).toBe(
      false
    );
  });

  it("accepts the raw nonce or its SHA-256, since the app may hash it before asking Apple", async () => {
    const verify = appleIdTokenVerifier("com.flexiday.app");
    const hashed = await signIdToken(key, {
      iss: APPLE,
      aud: "com.flexiday.app",
      nonce: sha256Hex("n-1"),
    });
    expect(await verify(hashed, "n-1")).toBe(true);
    expect(await verify(hashed, "n-2")).toBe(false);
  });
});
