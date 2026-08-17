type SocialCredentials = {
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
};

/**
 * A provider's word is not an email challenge.
 *
 * Both Google and Microsoft report an address as "verified" once the *domain*
 * side checks out, which is not the same as proving the person signing in
 * controls that mailbox. A Workspace or Entra administrator can set a user's
 * mail attribute to any address in a domain they administer and the claim
 * still comes back verified — Microsoft says outright that email claims must
 * not drive access decisions. Flexi Day does drive one: `handlePostGroupUser`
 * lets a verified address redeem a team invite bound to it.
 *
 * So social sign-in never confers a verified address. The account is created
 * unverified and better-auth sends our own confirmation email, exactly as an
 * email/password sign-up would; only clicking that link marks the address
 * verified. Consequence worth knowing: because better-auth gates implicit
 * account linking on this same flag, a social sign-in cannot attach itself to
 * a pre-existing account with the same address — it reports
 * `account_not_linked`, which the frontend renders as "use the method you
 * signed up with".
 */
const NEVER_TRUST_PROVIDER_EMAIL = () => ({ emailVerified: false });

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
            mapProfileToUser: NEVER_TRUST_PROVIDER_EMAIL,
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
            // Stated explicitly rather than left to better-auth, which would
            // otherwise derive it from `email_verified` / `xms_edov` /
            // `verified_primary_email` — all claims a directory administrator
            // controls.
            mapProfileToUser: NEVER_TRUST_PROVIDER_EMAIL,
          },
        }
      : {}),
  };

  return Object.keys(providers).length > 0 ? providers : undefined;
}
