import { describe, expect, it } from "vitest";
import { buildSocialProviders, entraEmailIsVerified } from "../../utils/socialProviders.js";

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

  it("only marks the Microsoft email verified when Entra vouches for the domain", () => {
    const map = buildSocialProviders(microsoft)?.microsoft?.mapProfileToUser;
    // Asserts the resulting emailVerified, not merely the shape: better-auth
    // spreads this over its own claim-derived value, so an absent key would
    // hand the decision back to claims a tenant admin controls.
    expect(map?.({ xms_edov: "1" })).toEqual({ emailVerified: true });
    expect(map?.({ xms_edov: "0" })).toEqual({ emailVerified: false });
    expect(map?.({})).toEqual({ emailVerified: false });
  });
});

describe("entraEmailIsVerified", () => {
  // Entra sends this as the string "1", not the boolean better-auth's
  // MicrosoftEntraIDProfile declares — confirmed against a real ID token, where
  // reading it as a boolean silently left a vouched-for address unverified.
  // Both forms must work, and only an affirmative value may pass.
  it.each([
    [{ xms_edov: "1" }, true],
    [{ xms_edov: true }, true],
    [{ xms_edov: 1 }, true],
    [{ xms_edov: "true" }, true],
    [{ xms_edov: "0" }, false],
    [{ xms_edov: false }, false],
    [{ xms_edov: 0 }, false],
    [{ xms_edov: "" }, false],
    [{ xms_edov: "yes" }, false],
    [{}, false],
    [{ xms_edov: undefined }, false],
    [{ xms_edov: null }, false],
  ])("%o -> %s", (profile, expected) => {
    expect(entraEmailIsVerified(profile)).toBe(expected);
  });
});
