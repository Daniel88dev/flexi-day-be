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
 * verified.
 *
 * Consequence worth knowing: a social sign-in cannot attach itself to a
 * pre-existing account with the same address. It reports `account_not_linked`,
 * which the frontend renders as "sign in with the method you used, then connect
 * this one from Settings". Attaching one is a deliberate act instead — see
 * `accountLinking` in `auth.ts` and the connected-accounts card in settings.
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

/**
 * Account-linking policy, derived from whichever providers are configured.
 *
 * The two settings only make sense together. `trustedProviders` is what lets a
 * provider be attached to an account at all — without it the deliberately-false
 * `emailVerified` above blocks every link. `disableImplicitLinking` then takes
 * back the part of that trust we do not want: the automatic attach during
 * sign-in, where the provider's claim about an address would be the only thing
 * standing between an attacker's directory and someone else's account.
 *
 * What remains is the explicit route: POST /link-social from a signed-in
 * session. There the session proves the Flexi Day account is the caller's and
 * the OAuth round trip proves the provider account is too, so no email claim is
 * load-bearing. `allowDifferentEmails` is left off, so the provider must still
 * report the account's own address.
 *
 * Naming a provider that is not configured would be harmless but misleading, so
 * the list is derived rather than written out.
 */
export function buildAccountLinking(providers: ReturnType<typeof buildSocialProviders>) {
  return {
    enabled: true,
    trustedProviders: Object.keys(providers ?? {}),
    disableImplicitLinking: true,
  };
}
