import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";
import { buildSocialProviders } from "../../utils/socialProviders.js";
import { appleCredentials, decodeJwtPart } from "../appleFixtures.js";

const microsoft = { microsoftClientId: "id", microsoftClientSecret: "secret" };
const google = { googleClientId: "id", googleClientSecret: "secret" };
const apple = appleCredentials();

describe("buildSocialProviders", () => {
  it("returns undefined when nothing is configured", () => {
    expect(buildSocialProviders(undefined)).toBeUndefined();
    expect(buildSocialProviders({})).toBeUndefined();
  });

  it.each([
    ["google", { googleClientId: "id" }],
    ["google", { googleClientSecret: "secret" }],
    ["microsoft", { microsoftClientId: "id" }],
    ["microsoft", { microsoftClientSecret: "secret" }],
  ])("does not register %s from a half-configured pair", (_provider, credentials) => {
    expect(buildSocialProviders(credentials)).toBeUndefined();
  });

  it.each(Object.keys(apple) as (keyof typeof apple)[])(
    "does not register apple without %s",
    (missing) => {
      expect(buildSocialProviders({ ...apple, [missing]: "" })).toBeUndefined();
      expect(buildSocialProviders({ ...apple, [missing]: undefined })).toBeUndefined();
    }
  );

  it("registers each provider independently of the others", () => {
    expect(Object.keys(buildSocialProviders(google) ?? {})).toEqual(["google"]);
    expect(Object.keys(buildSocialProviders(microsoft) ?? {})).toEqual(["microsoft"]);
    expect(Object.keys(buildSocialProviders(apple) ?? {})).toEqual(["apple"]);
    expect(
      Object.keys(buildSocialProviders({ ...google, ...microsoft, ...apple }) ?? {}).sort()
    ).toEqual(["apple", "google", "microsoft"]);
  });

  it("defaults the Microsoft tenant to common and honours an override", () => {
    expect(buildSocialProviders(microsoft)?.microsoft?.tenantId).toBe("common");
    expect(buildSocialProviders({ ...microsoft, microsoftTenantId: "" })?.microsoft?.tenantId).toBe(
      "common"
    );
    expect(
      buildSocialProviders({ ...microsoft, microsoftTenantId: "a-guid" })?.microsoft?.tenantId
    ).toBe("a-guid");
  });
});

describe("apple", () => {
  it("uses the Services ID for the web flow and the bundle id as the phone's audience", () => {
    const provider = buildSocialProviders(apple)?.apple;
    expect(provider?.clientId).toBe("com.flexiday.web");
    expect(provider?.appBundleIdentifier).toBe("com.flexiday.app");
  });

  it("serves a client secret minted for the Services ID", () => {
    const claims = decodeJwtPart(buildSocialProviders(apple)?.apple?.clientSecret, 1);
    expect(claims).toMatchObject({
      iss: "TEAM123456",
      sub: "com.flexiday.web",
      aud: "https://appleid.apple.com",
    });
  });

  it("exposes the secret through a getter, so every token request reads a current one", () => {
    const provider = buildSocialProviders(apple)?.apple;
    const descriptor = Object.getOwnPropertyDescriptor(provider, "clientSecret");
    expect(descriptor?.get).toBeTypeOf("function");
  });

  it("keeps the getter once better-auth has built the provider", async () => {
    // better-auth closes over the options object it was handed. A release that
    // copied it would freeze the first secret at boot, and Apple would start
    // refusing it an hour later with no error before then.
    const socialProviders = buildSocialProviders(apple);
    const instance = betterAuth({
      secret: "a-test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://localhost:8080",
      socialProviders,
    });
    const context = await instance.$context;
    const built = context.socialProviders.find((provider) => provider.id === "apple");

    expect(built?.options).toBe(socialProviders?.apple);
    expect(Object.getOwnPropertyDescriptor(built?.options, "clientSecret")?.get).toBeTypeOf(
      "function"
    );
  });

  it("refuses to start on a key it cannot sign with rather than registering a broken provider", () => {
    expect(() => buildSocialProviders({ ...apple, applePrivateKey: "not-a-key" })).toThrow(
      /APPLE_PRIVATE_KEY/
    );
  });
});

/**
 * The address on a session is what lets someone redeem a team invite bound to
 * it (`handlePostGroupUser`), so no provider claim may stand in for Flexi Day's
 * own email challenge. A directory administrator can set a user's mail
 * attribute to any address in a domain they administer, and every claim below
 * still comes back looking verified.
 */
describe("provider-supplied email is never trusted", () => {
  const claims = [
    ["Entra domain-owner flag, boolean", { xms_edov: true }],
    ["Entra domain-owner flag, string form Entra actually sends", { xms_edov: "1" }],
    ["OIDC email_verified", { email_verified: true }],
    ["OIDC email_verified, string form", { email_verified: "true" }],
    ["Entra verified primary email", { verified_primary_email: ["someone@example.com"] }],
    [
      "every affirmative claim at once",
      {
        xms_edov: "1",
        email_verified: true,
        verified_primary_email: ["someone@example.com"],
      },
    ],
    ["no claims at all", {}],
  ] as const;

  it.each(claims)("microsoft: %s -> unverified", (_label, profile) => {
    const map = buildSocialProviders(microsoft)?.microsoft?.mapProfileToUser;
    expect(map?.(profile)).toEqual({ emailVerified: false });
  });

  it.each(claims)("google: %s -> unverified", (_label, profile) => {
    const map = buildSocialProviders(google)?.google?.mapProfileToUser;
    expect(map?.(profile)).toEqual({ emailVerified: false });
  });

  it.each(claims)("apple: %s -> unverified", (_label, profile) => {
    const map = buildSocialProviders(apple)?.apple?.mapProfileToUser;
    expect(map?.(profile)).toEqual({ emailVerified: false });
  });

  it("states emailVerified rather than omitting it", () => {
    // better-auth spreads mapProfileToUser's result OVER its own claim-derived
    // value, so returning {} would hand the decision straight back to the
    // provider claims this whole rule exists to distrust.
    const result = buildSocialProviders(microsoft)?.microsoft?.mapProfileToUser?.({});
    expect(result).toHaveProperty("emailVerified");
  });
});
