type SocialCredentials = {
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
};

/**
 * Entra's `email` claim is directory data a tenant admin can set to an address
 * they do not own, so it must never by itself mark an account verified — a
 * verified address is what binds a team invite to its recipient. `xms_edov` is
 * Microsoft's own "this domain is verified" signal, and it is an *optional*
 * claim: unless the app registration requests it, this returns false and
 * better-auth leaves the account unverified, which is the safe direction.
 *
 * Entra sends it as the STRING "1", not a boolean, despite better-auth's
 * MicrosoftEntraIDProfile typing it `boolean` — observed in a real ID token on
 * 2026-08-17. Accept both, and only an affirmative value: absent, "0" and
 * false must all stay unverified.
 */
export const entraEmailIsVerified = (profile: { xms_edov?: unknown }): boolean => {
  const claim = profile.xms_edov;
  if (typeof claim === "boolean") return claim;
  if (typeof claim === "number") return claim === 1;
  if (typeof claim === "string") return claim === "1" || claim.toLowerCase() === "true";
  return false;
};

/**
 * Register each provider only when both of its credentials are present, so
 * non-production/test environments (and any deploy before the secrets are
 * wired) start cleanly instead of failing with an empty client id/secret.
 * Returns `undefined` when nothing is configured, which is what better-auth
 * expects for "no social sign-in".
 */
export function buildSocialProviders(auth?: SocialCredentials) {
  const providers = {
    ...(auth?.googleClientId && auth.googleClientSecret
      ? {
          google: {
            clientId: auth.googleClientId,
            clientSecret: auth.googleClientSecret,
          },
        }
      : {}),
    ...(auth?.microsoftClientId && auth.microsoftClientSecret
      ? {
          microsoft: {
            clientId: auth.microsoftClientId,
            clientSecret: auth.microsoftClientSecret,
            // "common" also admits personal Microsoft accounts; set
            // MICROSOFT_TENANT_ID to a directory GUID to pin sign-in to one org.
            tenantId: auth.microsoftTenantId || "common",
            // Always states emailVerified rather than returning {} for the
            // unverified case. better-auth spreads this over its OWN computed
            // value, which trusts `email_verified` / `verified_primary_email`
            // — Entra optional claims sourced from directory attributes a
            // tenant admin controls. Returning {} would leave that fallback in
            // charge, so adding one claim in the portal could silently mark a
            // hostile address verified and let it link onto a real account.
            mapProfileToUser: (profile: { xms_edov?: unknown }) => ({
              emailVerified: entraEmailIsVerified(profile),
            }),
          },
        }
      : {}),
  };

  return Object.keys(providers).length > 0 ? providers : undefined;
}
