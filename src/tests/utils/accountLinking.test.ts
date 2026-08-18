import { describe, expect, it } from "vitest";
import { auth } from "../../utils/auth.js";
import { buildAccountLinking, buildSocialProviders } from "../../utils/socialProviders.js";

/**
 * Guards the settings-page "connect Google/Microsoft" feature against being
 * bought at the price of the automatic linking it replaces. Every assertion
 * here is a rule an attacker would benefit from having relaxed.
 *
 * The policy is exercised through `buildAccountLinking` rather than through
 * `auth.options`: under vitest `config.auth` is undefined, so no provider is
 * configured and anything asserted about the wired object would be vacuous.
 */
describe("account linking policy", () => {
  const configured = buildSocialProviders({
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    microsoftClientId: "microsoft-id",
    microsoftClientSecret: "microsoft-secret",
  });
  const accountLinking = buildAccountLinking(configured);

  it("trusts every configured provider, or no link can ever be made", () => {
    // Without this, `mapProfileToUser`'s deliberately false `emailVerified`
    // makes better-auth refuse /link-social for everyone.
    expect(accountLinking.trustedProviders).toEqual(["google", "microsoft"]);
  });

  it("trusts nothing when no provider is configured", () => {
    expect(buildAccountLinking(undefined).trustedProviders).toEqual([]);
    expect(buildAccountLinking(buildSocialProviders({})).trustedProviders).toEqual([]);
  });

  it("never trusts a provider that is not configured", () => {
    const googleOnly = buildAccountLinking(
      buildSocialProviders({ googleClientId: "id", googleClientSecret: "secret" })
    );
    expect(googleOnly.trustedProviders).toEqual(["google"]);
  });

  it("never links a provider onto an existing account during sign-in", () => {
    // Without this, the trust above is enough for a directory administrator to
    // sign in with a mail attribute they set to someone else's address and land
    // inside that person's account.
    expect(accountLinking.disableImplicitLinking).toBe(true);
  });

  it("is the policy the running auth instance actually uses", () => {
    // The assertions above are worth nothing if auth.ts stops calling this.
    expect(auth.options.account?.accountLinking).toEqual(
      buildAccountLinking(auth.options.socialProviders)
    );
  });

  it("requires a linked provider to report the account's own address", () => {
    // `allowDifferentEmails` would let any provider account be attached to any
    // session, which is the documented account-takeover shape.
    expect(auth.options.account?.accountLinking?.allowDifferentEmails).not.toBe(true);
  });

  it("keeps at least one sign-in method on every account", () => {
    expect(auth.options.account?.accountLinking?.allowUnlinkingAll).not.toBe(true);
  });

  it("does not let a link overwrite the local profile", () => {
    expect(auth.options.account?.accountLinking?.updateUserInfoOnLink).not.toBe(true);
  });
});
