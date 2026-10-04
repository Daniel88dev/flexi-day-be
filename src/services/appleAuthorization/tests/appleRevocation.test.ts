import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../middleware/logger.js";
import {
  appleCredentials,
  decodeJwtPart,
  storedIdToken,
  stubAppleRevoke,
} from "../../../tests/appleFixtures.js";
import { appleClientFrom, type AppleClient } from "../../../utils/socialProviders.js";
import { appleRevocationOf, revokeAtApple } from "../appleRevocation.js";
import type { AppleRevocation, StoredAppleLink } from "../types.js";

const SERVICES_ID = "com.flexiday.web";
const BUNDLE_ID = "com.flexiday.app";

const decryptStub = async (stored: string) => stored.replace(/^enc:/, "");

let client: AppleClient;
let apple: ReturnType<typeof stubAppleRevoke>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const configured = appleClientFrom(appleCredentials());
  if (!configured) throw new Error("Apple fixture is incomplete");
  client = configured;
  apple = stubAppleRevoke();
  warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
  error = vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appleRevocationOf", () => {
  const link = (overrides: Partial<StoredAppleLink> = {}): StoredAppleLink => ({
    id: "account-row-1",
    userId: "user-1",
    refreshToken: "enc:apple-refresh-token",
    idToken: storedIdToken({ aud: BUNDLE_ID, sub: "001234.abc.1234" }),
    ...overrides,
  });

  it("reads the audience from the stored id token and decrypts the refresh token", async () => {
    expect(await appleRevocationOf(link(), SERVICES_ID, decryptStub)).toEqual({
      linkId: "account-row-1",
      audience: BUNDLE_ID,
      refreshToken: "apple-refresh-token",
    });
  });

  it("takes the first audience when the id token lists several", async () => {
    const revocation = await appleRevocationOf(
      link({ idToken: storedIdToken({ aud: [SERVICES_ID, "other"] }) }),
      BUNDLE_ID,
      decryptStub
    );
    expect(revocation.audience).toBe(SERVICES_ID);
  });

  it.each([
    ["no id token is stored", null],
    ["the stored id token does not decode", "not-a-jwt"],
    ["the stored id token names no audience", storedIdToken({ sub: "001234.abc.1234" })],
  ])("falls back to the Services ID when %s", async (_label, idToken) => {
    const revocation = await appleRevocationOf(link({ idToken }), SERVICES_ID, decryptStub);
    expect(revocation.audience).toBe(SERVICES_ID);
  });

  it("carries no token for a link that holds none", async () => {
    const revocation = await appleRevocationOf(
      link({ refreshToken: null }),
      SERVICES_ID,
      decryptStub
    );
    expect(revocation.refreshToken).toBeNull();
  });

  it("carries no token, logged, when the stored one cannot be decrypted", async () => {
    const revocation = await appleRevocationOf(link(), SERVICES_ID, () =>
      Promise.reject(new Error("bad decrypt"))
    );

    expect(revocation.refreshToken).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "apple.revoke.unreadable_token",
      expect.objectContaining({ userId: "user-1", linkId: "account-row-1" })
    );
  });
});

describe("revokeAtApple", () => {
  const webLink: AppleRevocation = {
    linkId: "account-row-web",
    audience: SERVICES_ID,
    refreshToken: "web-refresh-token",
  };
  const phoneLink: AppleRevocation = {
    linkId: "account-row-phone",
    audience: BUNDLE_ID,
    refreshToken: "phone-refresh-token",
  };

  it("posts once per link, as the client its tokens were issued to", async () => {
    await revokeAtApple(client, "user-1", [webLink, phoneLink]);

    const forms = apple.revokeForms();
    expect(forms).toHaveLength(2);
    for (const [form, link] of [
      [forms[0], webLink],
      [forms[1], phoneLink],
    ] as const) {
      expect(form?.get("client_id")).toBe(link.audience);
      expect(form?.get("token")).toBe(link.refreshToken);
      expect(form?.get("token_type_hint")).toBe("refresh_token");
      expect(decodeJwtPart(form?.get("client_secret") ?? undefined, 1)).toMatchObject({
        iss: "TEAM123456",
        sub: link.audience,
        aud: "https://appleid.apple.com",
      });
    }
    const [, init] = apple.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("skips and logs a link without a token, and still revokes the others", async () => {
    await revokeAtApple(client, "user-1", [{ ...webLink, refreshToken: null }, phoneLink]);

    expect(apple.revokeForms().map((form) => form.get("token"))).toEqual(["phone-refresh-token"]);
    expect(warn).toHaveBeenCalledWith("apple.revoke.no_token", {
      userId: "user-1",
      linkId: "account-row-web",
    });
  });

  it.each([
    [
      "Apple rejects the call",
      () => Promise.resolve(Response.json({ error: "invalid_client" }, { status: 400 })),
      "apple.revoke.rejected",
    ],
    [
      "Apple cannot be reached",
      () => Promise.reject(new TypeError("fetch failed")),
      "apple.revoke.unreachable",
    ],
  ])("does not throw when %s, logs it by user id and goes on", async (_label, answer, event) => {
    apple.answerWith(answer);

    await expect(revokeAtApple(client, "user-1", [webLink, phoneLink])).resolves.toBeUndefined();

    expect(apple.revokeForms()).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ userId: "user-1", linkId: "account-row-web" })
    );
    for (const [, fields] of error.mock.calls) {
      expect(JSON.stringify(fields)).not.toContain("refresh-token");
    }
  });

  it("names Apple's error code when it rejects the call", async () => {
    apple.answerWith(() =>
      Promise.resolve(Response.json({ error: "invalid_client" }, { status: 400 }))
    );

    await revokeAtApple(client, "user-1", [webLink]);

    expect(error).toHaveBeenCalledWith("apple.revoke.rejected", {
      userId: "user-1",
      linkId: "account-row-web",
      status: 400,
      "apple.error": "invalid_client",
    });
  });

  it("revokes nothing when Apple is not configured on this server", async () => {
    await revokeAtApple(undefined, "user-1", [webLink, phoneLink]);

    expect(apple.fetchMock).not.toHaveBeenCalled();
  });
});
