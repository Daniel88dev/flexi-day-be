import { describe, expect, it } from "vitest";
import { buildSocialProviders } from "../../utils/socialProviders.js";

const microsoft = { microsoftClientId: "id", microsoftClientSecret: "secret" };
const google = { googleClientId: "id", googleClientSecret: "secret" };

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

  it("registers each provider independently of the other", () => {
    expect(Object.keys(buildSocialProviders(google) ?? {})).toEqual(["google"]);
    expect(Object.keys(buildSocialProviders(microsoft) ?? {})).toEqual(["microsoft"]);
    expect(Object.keys(buildSocialProviders({ ...google, ...microsoft }) ?? {}).sort()).toEqual([
      "google",
      "microsoft",
    ]);
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

  it("states emailVerified rather than omitting it", () => {
    // better-auth spreads mapProfileToUser's result OVER its own claim-derived
    // value, so returning {} would hand the decision straight back to the
    // provider claims this whole rule exists to distrust.
    const result = buildSocialProviders(microsoft)?.microsoft?.mapProfileToUser?.({});
    expect(result).toHaveProperty("emailVerified");
  });
});
