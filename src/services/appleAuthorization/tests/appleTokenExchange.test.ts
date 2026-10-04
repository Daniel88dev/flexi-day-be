import type { JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appleCredentials, decodeJwtPart } from "../../../tests/appleFixtures.js";
import { newSigningKey, signIdToken, type TestSigningKey } from "../../../tests/idTokenFixtures.js";
import { appleClientFrom, type AppleClient } from "../../../utils/socialProviders.js";
import { exchangeAppleAuthorizationCode } from "../appleTokenExchange.js";

const TOKEN_URL = "https://appleid.apple.com/auth/token";
const KEYS_URL = "https://appleid.apple.com/auth/keys";
const BUNDLE_ID = "com.flexiday.app";
const SUBJECT = "001234.abcdef0123456789.1234";
const T0 = new Date("2026-10-04T12:00:00Z");

let key: TestSigningKey;
let client: AppleClient;
let tokenAnswer: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

const answerWithTokens = (claims: JWTPayload = {}) => {
  tokenAnswer = async () =>
    Response.json({
      access_token: "apple-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "apple-refresh-token",
      id_token: await signIdToken(key, {
        iss: "https://appleid.apple.com",
        aud: BUNDLE_ID,
        sub: SUBJECT,
        ...claims,
      }),
    });
};

const tokenRequests = () =>
  fetchMock.mock.calls.filter(([input]) => String(input) === TOKEN_URL) as [string, RequestInit][];

beforeAll(async () => {
  key = await newSigningKey("apple-key-1");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const configured = appleClientFrom(appleCredentials());
  if (!configured) throw new Error("Apple fixture is incomplete");
  client = configured;
  answerWithTokens();
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href === TOKEN_URL) return tokenAnswer();
    if (href === KEYS_URL) return Response.json({ keys: [key.jwk] });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("exchangeAppleAuthorizationCode", () => {
  it("exchanges the code as the app, with a secret minted for the bundle id", async () => {
    await exchangeAppleAuthorizationCode(client, "c0de.0.abc");

    const [[, init]] = tokenRequests() as [[string, RequestInit]];
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("c0de.0.abc");
    expect(form.get("client_id")).toBe(BUNDLE_ID);
    expect(form.has("redirect_uri")).toBe(false);
    expect(decodeJwtPart(form.get("client_secret") ?? undefined, 1)).toMatchObject({
      iss: "TEAM123456",
      sub: BUNDLE_ID,
      aud: "https://appleid.apple.com",
    });
  });

  it("returns the tokens, their expiry and the verified subject", async () => {
    const exchanged = await exchangeAppleAuthorizationCode(client, "c0de.0.abc");

    expect(exchanged).toMatchObject({
      accessToken: "apple-access-token",
      refreshToken: "apple-refresh-token",
      accessTokenExpiresAt: new Date(T0.getTime() + 3600 * 1000),
      subject: SUBJECT,
    });
    expect(decodeJwtPart(exchanged?.idToken, 1)).toMatchObject({ sub: SUBJECT, aud: BUNDLE_ID });
  });

  it("returns null when Apple rejects the code, and asks only once", async () => {
    tokenAnswer = async () => Response.json({ error: "invalid_grant" }, { status: 400 });

    expect(await exchangeAppleAuthorizationCode(client, "c0de.0.abc")).toBeNull();
    expect(tokenRequests()).toHaveLength(1);
  });

  it.each([
    ["Apple cannot be reached", () => Promise.reject(new TypeError("fetch failed"))],
    ["the answer carries no refresh token", () => Promise.resolve(Response.json({}))],
  ])("returns null when %s", async (_label, answer) => {
    tokenAnswer = answer;
    expect(await exchangeAppleAuthorizationCode(client, "c0de.0.abc")).toBeNull();
  });

  it.each([
    ["is issued to the Services ID", { aud: "com.flexiday.web" }],
    ["names another issuer", { iss: "https://evil.example.test" }],
  ])("returns null when the id token %s", async (_label, claims) => {
    answerWithTokens(claims);
    expect(await exchangeAppleAuthorizationCode(client, "c0de.0.abc")).toBeNull();
  });
});
