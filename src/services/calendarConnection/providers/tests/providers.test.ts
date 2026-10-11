import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from "./fakeTokenEndpoint.js";
import { createMicrosoftAdapter, MICROSOFT_SCOPE } from "../microsoft.js";
import { createGoogleAdapter, GOOGLE_SCOPE } from "../google.js";
import { ProviderGrantRevokedError, ProviderTokenError } from "../types.js";

const CLIENT = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:8080/api/calendar-sync/connections/x/callback",
};

let endpoint: FakeTokenEndpoint;

beforeAll(async () => {
  endpoint = await startFakeTokenEndpoint();
});

afterAll(async () => {
  await endpoint.close();
});

beforeEach(() => {
  endpoint.requests.length = 0;
});

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

describe("Microsoft adapter", () => {
  const adapter = () =>
    createMicrosoftAdapter({
      ...CLIENT,
      authority: `${endpoint.url}/common/oauth2/v2.0`,
    });

  it("asks the common authority for consent to the calendar scope", () => {
    const url = new URL(createMicrosoftAdapter(CLIENT).consentUrl("signed-state"));

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      response_type: "code",
      response_mode: "query",
      redirect_uri: CLIENT.redirectUri,
      scope: "Calendars.ReadWrite offline_access",
      prompt: "consent",
      state: "signed-state",
    });
    expect(MICROSOFT_SCOPE).toBe("Calendars.ReadWrite offline_access");
  });

  it("refreshes an expiring token and hands back the rotated refresh token", async () => {
    endpoint.answer(() => ({
      status: 200,
      body: {
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "https://graph.microsoft.com/Calendars.ReadWrite",
      },
    }));
    const now = Date.now();

    const fresh = await adapter().accessToken(
      { accessToken: "access-1", expiresAt: new Date(now + 30_000), refreshToken: "refresh-1" },
      now
    );

    expect(fresh).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: new Date(now + 3600 * 1000),
      refreshed: true,
    });
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]!.path).toBe("/common/oauth2/v2.0/token");
    expect(Object.fromEntries(endpoint.requests[0]!.form)).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      scope: "Calendars.ReadWrite offline_access",
    });
  });

  it("keeps a token with more than a minute left without calling out", async () => {
    const now = Date.now();

    const fresh = await adapter().accessToken(
      { accessToken: "access-1", expiresAt: new Date(now + 120_000), refreshToken: "refresh-1" },
      now
    );

    expect(fresh).toMatchObject({ accessToken: "access-1", refreshed: false });
    expect(endpoint.requests).toHaveLength(0);
  });

  it.each(["invalid_grant", "interaction_required"])(
    "reports %s as a revoked grant",
    async (error) => {
      endpoint.answer(() => ({
        status: 400,
        body: { error, error_description: "AADSTS70008: expired", error_codes: [70008] },
      }));

      const thrown = await rejectionOf(
        adapter().accessToken({ accessToken: null, expiresAt: null, refreshToken: "refresh-1" })
      );

      expect(thrown).toBeInstanceOf(ProviderGrantRevokedError);
    }
  );

  it("reports any other failure as a plain token error", async () => {
    endpoint.answer(() => ({ status: 503, body: { error: "temporarily_unavailable" } }));

    const thrown = await rejectionOf(
      adapter().accessToken({ accessToken: null, expiresAt: null, refreshToken: "refresh-1" })
    );

    expect(thrown).toBeInstanceOf(ProviderTokenError);
    expect(thrown).not.toBeInstanceOf(ProviderGrantRevokedError);
  });

  it("exchanges a code for tokens", async () => {
    endpoint.answer(() => ({
      status: 200,
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: "https://graph.microsoft.com/Calendars.ReadWrite",
      },
    }));

    const tokens = await adapter().exchangeCode("the-code");

    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      scope: "https://graph.microsoft.com/Calendars.ReadWrite",
    });
    expect(Object.fromEntries(endpoint.requests[0]!.form)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: CLIENT.redirectUri,
    });
  });
});

describe("Google adapter", () => {
  const adapter = () =>
    createGoogleAdapter({
      ...CLIENT,
      endpoints: {
        oauth2TokenUrl: `${endpoint.url}/token`,
        oauth2RevokeUrl: `${endpoint.url}/revoke`,
      },
    });

  it("asks for offline consent to the owned-events scope alone", () => {
    const url = new URL(createGoogleAdapter(CLIENT).consentUrl("signed-state"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.events.owned"
    );
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(CLIENT.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(GOOGLE_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events.owned");
  });

  it("refreshes inside the 60 s skew and keeps the refresh token", async () => {
    endpoint.answer(() => ({
      status: 200,
      body: { access_token: "access-2", expires_in: 3599, token_type: "Bearer" },
    }));

    const fresh = await adapter().accessToken({
      accessToken: "access-1",
      expiresAt: new Date(Date.now() + 30_000),
      refreshToken: "refresh-1",
    });

    expect(fresh).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-1",
      refreshed: true,
    });
    expect(fresh.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(endpoint.requests[0]!.form.get("grant_type")).toBe("refresh_token");
    expect(endpoint.requests[0]!.form.get("refresh_token")).toBe("refresh-1");
  });

  it("keeps a token with more than a minute left without calling out", async () => {
    const fresh = await adapter().accessToken({
      accessToken: "access-1",
      expiresAt: new Date(Date.now() + 120_000),
      refreshToken: "refresh-1",
    });

    expect(fresh).toMatchObject({ accessToken: "access-1", refreshed: false });
    expect(endpoint.requests).toHaveLength(0);
  });

  it("reports invalid_grant as a revoked grant", async () => {
    endpoint.answer(() => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    }));

    const thrown = await rejectionOf(
      adapter().accessToken({ accessToken: null, expiresAt: null, refreshToken: "refresh-1" })
    );

    expect(thrown).toBeInstanceOf(ProviderGrantRevokedError);
  });

  it("exchanges a code and revokes the refresh token", async () => {
    endpoint.answer((request) =>
      request.path.startsWith("/revoke")
        ? { status: 200, body: {} }
        : {
            status: 200,
            body: {
              access_token: "access-1",
              refresh_token: "refresh-1",
              expires_in: 3599,
              scope: GOOGLE_SCOPE,
            },
          }
    );

    const tokens = await adapter().exchangeCode("the-code");
    await adapter().revoke("refresh-1");

    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      scope: GOOGLE_SCOPE,
    });
    expect(endpoint.requests[0]!.form.get("code")).toBe("the-code");
    expect(endpoint.requests[1]!.path).toBe("/revoke?token=refresh-1");
  });
});
