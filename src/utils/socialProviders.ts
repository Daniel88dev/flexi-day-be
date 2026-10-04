import { createAppleSecretMinter, type AppleSecretMinter } from "./appleClientSecret.js";
import {
  appleIdTokenReader,
  appleIdTokenVerifier,
  googleIdTokenVerifier,
  microsoftIdTokenVerifier,
  type IdTokenReader,
} from "./idTokenVerifier.js";

type SocialCredentials = {
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
  appleClientId?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  appleAppBundleIdentifier?: string;
  applePrivateKey?: string;
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
 * So social sign-in, Apple's included, never confers a verified address. The
 * account is created unverified and better-auth sends our own confirmation
 * email, exactly as an email/password sign-up would; only clicking that link
 * marks the address verified.
 *
 * Consequence worth knowing: a social sign-in cannot attach itself to a
 * pre-existing account with the same address. It reports `account_not_linked`,
 * which the frontend renders as "sign in with the method you used, then connect
 * this one from Settings". Attaching one is a deliberate act instead — see
 * `accountLinking` in `auth.ts` and the connected-accounts card in settings.
 */
const NEVER_TRUST_PROVIDER_EMAIL = () => ({ emailVerified: false });

/**
 * Apple is two clients behind one key: the Services ID signs in on the web,
 * the bundle id on the phone. Each needs a secret minted with itself as the
 * subject, so the provider and the phone's authorization route share this.
 */
export type AppleClient = {
  servicesId: string;
  bundleId: string;
  minter: AppleSecretMinter;
  /** The verified claims of an id token issued to the bundle id, or null. */
  readIdToken: IdTokenReader;
};

export function appleClientFrom(auth?: SocialCredentials): AppleClient | undefined {
  const servicesId = auth?.appleClientId;
  const teamId = auth?.appleTeamId;
  const keyId = auth?.appleKeyId;
  const bundleId = auth?.appleAppBundleIdentifier;
  const privateKey = auth?.applePrivateKey;
  if (!servicesId || !teamId || !keyId || !bundleId || !privateKey) return undefined;

  return {
    servicesId,
    bundleId,
    minter: createAppleSecretMinter({ teamId, keyId, privateKey }),
    readIdToken: appleIdTokenReader(bundleId),
  };
}

function buildApple(client: AppleClient | undefined) {
  if (!client) return {};

  const { servicesId, bundleId, minter } = client;
  return {
    apple: {
      // The Services ID: the web flow's client_id and the secret's subject.
      clientId: servicesId,
      // A getter, so each token request reads a current secret.
      get clientSecret() {
        return minter.secretFor(servicesId);
      },
      // better-auth's own audience check no longer runs once verifyIdToken is
      // set; this stays so the config names the audience the verifier is given.
      appBundleIdentifier: bundleId,
      verifyIdToken: appleIdTokenVerifier(bundleId),
      mapProfileToUser: NEVER_TRUST_PROVIDER_EMAIL,
    },
  };
}

/**
 * Register each provider only when all of its credentials are present, so
 * non-production/test environments (and any deploy before the secrets are
 * wired) start cleanly instead of failing with an empty client id/secret.
 * Returns `undefined` when nothing is configured, which is what better-auth
 * expects for "no social sign-in".
 */
export function buildSocialProviders(
  auth: SocialCredentials | undefined,
  apple: AppleClient | undefined
) {
  // "common" also admits personal Microsoft accounts; set MICROSOFT_TENANT_ID
  // to a directory GUID to pin sign-in to one org.
  const microsoftTenant = auth?.microsoftTenantId || "common";
  const providers = {
    ...(auth?.googleClientId && auth.googleClientSecret
      ? {
          google: {
            clientId: auth.googleClientId,
            clientSecret: auth.googleClientSecret,
            // Does not enforce better-auth's `hd` option; configuring `hd` needs
            // the verifier extended.
            verifyIdToken: googleIdTokenVerifier(auth.googleClientId),
            mapProfileToUser: NEVER_TRUST_PROVIDER_EMAIL,
          },
        }
      : {}),
    ...(auth?.microsoftClientId && auth.microsoftClientSecret
      ? {
          microsoft: {
            clientId: auth.microsoftClientId,
            clientSecret: auth.microsoftClientSecret,
            tenantId: microsoftTenant,
            verifyIdToken: microsoftIdTokenVerifier(auth.microsoftClientId, microsoftTenant),
            // Stated explicitly rather than left to better-auth, which would
            // otherwise derive it from `email_verified` / `xms_edov` /
            // `verified_primary_email` — all claims a directory administrator
            // controls.
            mapProfileToUser: NEVER_TRUST_PROVIDER_EMAIL,
          },
        }
      : {}),
    ...buildApple(apple),
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
