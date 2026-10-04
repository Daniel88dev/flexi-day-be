# Social sign-in

The rules behind the **Social sign-in**, **Account link** and **Apple authorization** rows in
[`CONTEXT.md`](../CONTEXT.md). Google, Microsoft and Apple sign in through better-auth, configured
in `src/utils/socialProviders.ts` and wired in `src/utils/auth.ts`. The security boundaries that
must survive a change are in [`invariants.md`](invariants.md#authentication-srcutilsauthts); this
page explains how the pieces fit. The Terraform side of the Apple key is in
[`terraform.md`](terraform.md#sign-in-with-apple).

## Providers

A provider is registered only when all of its values are set, so an environment without them starts
cleanly and offers no button for it.

| Provider  | Values                                                                                                                   | Web client           | Audience of a phone id token |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---------------------------- |
| Google    | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                               | The web client       | The web client id            |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` (default `common`)                               | The app registration | The same client id           |
| Apple     | `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_APP_BUNDLE_IDENTIFIER`, `APPLE_PRIVATE_KEY` | The Services ID      | The bundle id                |

What each phone id token must pass, in `src/utils/idTokenVerifier.ts`:

- **Every provider:** a signature by a key from the provider's published set, RS256, not expired,
  issued within the last hour, the audience in the table, and the nonce when the request sends
  one.
- **Google:** issuer `https://accounts.google.com` or `accounts.google.com`. better-auth's `hd`
  option is not enforced, so configuring `hd` needs the verifier extended.
- **Microsoft:** the issuer must be `https://login.microsoftonline.com/<tid>/v2.0` for the token's
  own `tid`, because `common` admits every tenant. `organizations` refuses personal accounts and
  `consumers` admits only them.
- **Apple:** issuer `https://appleid.apple.com`. The nonce matches in raw form or as its SHA-256,
  because an app may hand Apple either.

## Two ways in, one profile mapping

On the web, `/sign-in/social` redirects to the provider, which returns to
`/api/auth/callback/<provider>`. better-auth exchanges the code there and stores the provider's
access, refresh and id token on the Account link. Apple POSTs that callback from
`https://appleid.apple.com`, so that origin is trusted in production (Terraform appends it).

The phone posts the provider's id token to `/sign-in/social` as
`idToken: { token, nonce?, user? }`. No code is exchanged, so the link gains the id token and no
refresh token. The request carries the phone's client headers, so the session it opens is a Native
session, as an email sign-in from the phone would be.

Both paths run the same `mapProfileToUser`, which reports every address as unverified whatever the
provider claims. A new address creates an account the way the web always has: unverified, in no
group, with our own confirmation email. An address that already has an account without this provider
is refused: the web callback redirects with `error=account_not_linked`, and the phone gets 401 with
code `OAUTH_LINK_ERROR`. The user signs in the way they did before and connects the provider from
Settings on the web, which is the only way an Account link is made, never by matching an address.
Social sign-in never runs our second factor.

## Apple's client secret

Apple has no static client secret. `src/utils/appleClientSecret.ts` mints one from the `.p8` key: an
ES256 JWT with the team id as issuer, the client as subject, and a one-hour life. It is cached per
subject and minted again once under five minutes remain. The key is parsed at boot and must be EC
P-256, so a bad key stops the service rather than breaking the button later.

Apple is two clients behind that one key, so the secret has two subjects:

- the Services ID, for the web callback's token requests and for revoking a web link;
- the bundle id, for exchanging the phone's authorization code and for revoking a phone link.

## Apple authorization

Apple asks an app to revoke the user's tokens at Apple when the account goes, and revoking takes a
refresh token that a phone sign-in never stores. Right after an Apple sign-in the phone posts the
one-time `authorizationCode` from Apple's sheet to `POST /api/users/me/apple-authorization`. The
backend exchanges it at Apple's token endpoint as the bundle id, verifies the returned id token
(issuer Apple, audience the bundle id), and stores the tokens on the caller's Apple link whose
account id equals the token's subject.

| Answer | `errors[0].context.reason` | When                                                         |
| ------ | -------------------------- | ------------------------------------------------------------ |
| 204    |                            | Stored                                                       |
| 403    | `NATIVE_SESSION_REQUIRED`  | A web session                                                |
| 409    | `APPLE_ACCOUNT_MISSING`    | The caller has no Apple link                                 |
| 409    | `APPLE_SUBJECT_MISMATCH`   | The code belongs to another Apple ID                         |
| 502    | `APPLE_EXCHANGE_FAILED`    | Apple refused or was unreachable, or its answer was unusable |

None of the refusals store anything. The 403 comes from `assertNativeSession` in
`src/utils/nativeSession.ts`, the shared refusal for every phone-only route; a later phone-only
route, push registration among them, reuses it. A code is single-use and dies in five minutes, so
nothing retries: the next Apple sign-in on the phone brings a new code and fills a link that missed
one. A repeat sign-in keeps the stored refresh token, because better-auth leaves out the fields the
id-token path does not carry.

No script or test in this repo generates or parses the `@openapi` blocks, so the route's block is
checked by hand, by parsing its YAML.

## Revocation at Apple

When an Apple link goes, `src/services/appleAuthorization/appleRevocation.ts` revokes its refresh
token at Apple as the client the token was issued to. Account deletion reads the links before its
transaction and revokes after the commit. Disconnecting Apple in Settings goes through
better-auth's `/unlink-account`, whose `accountId` is the `account` row id: the
`apple-unlink-revocation` plugin (`src/utils/appleUnlinkRevocation.ts`) reads that row in a
before-hook, and its after-hook revokes only when the unlink answered `status: true`, which also
proves the row was the caller's. The sequence, the best-effort rules and the log events are in
[`account-deletion.md`](account-deletion.md#apple-links).

## Stored tokens

`account.encryptOAuthTokens` is on, so better-auth encrypts every access and refresh token it
writes with the auth secret, and the Apple authorization route writes through the same helper.
Code that reads a token straight from the `account` table decrypts it with
`decryptStoredOAuthToken` (`src/utils/oauthTokens.ts`). Rows written before encryption went on
still hold plaintext; better-auth's decrypt passes a value that does not look encrypted through
unchanged, so there was no migration.

The id token is stored as better-auth stores it, unencrypted, on every sign-in and link and by the
authorization route alike. That is why revocation can decode its `aud` directly.

## Id-token key caching

better-auth's stock id-token check downloads the provider's key set on every phone sign-in, so each
tap cost a round trip and an outage at the provider became a sign-in outage. Each provider instead
carries a `verifyIdToken` backed by a `jose` remote key set: one download shared by concurrent
callers, refreshed after ten minutes or when a token names an unknown key id, and at most once
every thirty seconds. Once a provider has the option, better-auth runs no check of its own, so
every rule in [Providers](#providers) lives in the verifier. Microsoft publishes its keys without an
`alg`, which better-auth's stock import refuses; the key set takes the algorithm from the token
header instead.

## Known limitations

- **Conditional access.** A Microsoft tenant that requires an approved client app or an app
  protection policy blocks the phone, as it blocks Safari on that iPhone. A tenant that requires a
  compliant device can allowlist the bundle id; whether a sign-in sheet the app opens counts as
  Safari or as the app is unconfirmed.
- **Hidden email.** An Apple user who hides their address gets a relay address that never matches
  an existing account, so connecting Apple from Settings fails for them, with a message of its own
  on the web. Mail to a relay address arrives only because the sending domain is registered with
  Apple's relay and signed with Easy DKIM.
- **Second factor.** Social sign-in skips our second factor on the web and the phone alike.
- **Google's nonce.** Google's iOS SDK offers no nonce, so a Google id-token sign-in has no replay
  protection beyond the token's audience and its one-hour age.
- **Apple's name.** Apple sends the user's name only on the first authorization. An account
  created by a later one stores an empty name.
- **A token for the other client.** A phone sign-in replaces the link's id token but keeps its
  refresh token. If a link holding a web refresh token signs in on the phone and the authorization
  follow-up never lands, the stored id token names the bundle id while the refresh token belongs to
  the Services ID, and Apple refuses the revoke. It is logged as `apple.revoke.rejected`.
- **Android** is not covered.
