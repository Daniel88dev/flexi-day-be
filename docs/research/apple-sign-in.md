# Sign in with Apple: what better-auth 1.7.6 needs, and how the backend holds the client secret

Researched 2026-10-04 against better-auth 1.7.6 and `@better-auth/core` 1.7.6 as installed in
`node_modules`, Apple's developer documentation, and the Expo SDK 57 docs. Source paths below are
relative to the `flexi-day-be` root. Bracketed numbers point to the Sources list.

## Answer

better-auth's `apple` provider takes one `clientId` (the Services ID), one `clientSecret`, and an
optional `appBundleIdentifier`. The web flow uses the first two for the code exchange. The phone
flow never touches the secret: `/sign-in/social` with an `idToken` verifies the token against
Apple's JWKS, and once `appBundleIdentifier` is set it accepts the bundle id as the only audience.
Profiles go through `mapProfileToUser` on every path, so `emailVerified: false` holds for Apple as it
does for Google and Microsoft. Two things need work beyond configuration. better-auth stores no
Apple refresh token for a phone sign-in, so account deletion cannot revoke that user's tokens
without an extra code exchange. And a user who hides their email gets a relay address that never
matches an existing account, so under the current linking rules they cannot connect Apple to it.

Apple refuses a client secret whose `exp` lies more than 15777000 seconds (six months) in the
future, and there is no longer option [1]. better-auth reads `options.clientSecret` on every token
request, from the same object the integrator passed in, so a property getter works. The backend
should hold the `.p8` key, not a JWT, and mint short-lived secrets lazily behind a getter with a
cache keyed on expiry. Minting once at start-up breaks the first time a process outlives six months,
and nothing in this stack restarts it before then.

## 1. Client secret lifetime

**Apple's limit.** The client secret is a JWT with header `alg: ES256` and `kid`, and claims
`iss` (Team ID), `iat`, `exp`, `aud: https://appleid.apple.com` and `sub` (the App ID or Services ID
used as `client_id`, case-sensitive). It is signed with ECDSA P-256 and SHA-256. Apple says it is
"an error to request an expiration time more than 15777000 seconds" ahead, measured by Apple's clock
[1]. Note the reference point. The limit is on `exp` relative to Apple's clock when the request
arrives, not relative to `iat`. No longer lifetime exists, and nothing stops a much shorter one.
better-auth's own docs repeat the six-month limit and tell the integrator to regenerate before
expiry [12].

**How better-auth reads it.**

- `createContext` builds each provider by calling `socialProviders[key](config)` with the config
  object as passed (`node_modules/better-auth/dist/context/create-context.mjs:98-105`). This runs
  before `runPluginInit` merges plugin options (line 229), so the provider closes over our object,
  not a copy.
- If the config entry is a function, it is awaited once at that point (line 99). A function form
  therefore means "computed at start-up", not "per request".
- The `apple` provider passes that same `options` object to `validateAuthorizationCode` and
  `refreshAccessToken` (`node_modules/@better-auth/core/dist/social-providers/apple.mjs:37-58`), and
  checks `options.clientSecret` when building the authorize URL (line 17).
- `applyTokenEndpointAuth` reads `options.clientSecret` on each call and posts it as `client_secret`
  (`node_modules/@better-auth/core/dist/oauth2/token-endpoint-auth.mjs:7,24-27`). The type is
  `string`. There is no function or async form for the secret itself.

A probe against the installed packages confirmed it. A config object with `get clientSecret()` came
through `betterAuth()` as the identical object, init never read the getter, and each
`validateAuthorizationCode` call read it three times and posted the latest value. So a getter works,
but it must be synchronous and runs several times per exchange, hence the cache.

**Proposal.** Mint lazily, cache per `sub`, re-mint when fewer than five minutes remain. One hour of
lifetime is plenty and limits what a leaked secret is worth. Signing has to be synchronous for the
getter, so use `node:crypto` (`sign("sha256", input, { key, dsaEncoding: "ieee-p1363" })`) rather
than `jose`, whose `SignJWT.sign` returns a promise. `jose` 6.2.12 is installed only as a dependency
of better-auth and `@better-auth/core` (`npm ls jose`); `package.json` lists no JWT library. A probe
signed a token this way and `jose.jwtVerify` accepted it with `alg: ES256`.

```ts
// src/utils/appleClientSecret.ts: (sub) => JWT, cached until 5 minutes before exp
export function appleClientSecretMinter(key: AppleKey) {
  const cache = new Map<string, { jwt: string; exp: number }>();
  return (sub: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const hit = cache.get(sub);
    if (hit && hit.exp - now > 300) return hit.jwt;
    const exp = now + 3600;
    const claims = { iss: key.teamId, iat: now, exp, aud: "https://appleid.apple.com", sub };
    const jwt = signEs256({ alg: "ES256", kid: key.keyId }, claims, key.privateKey);
    cache.set(sub, { jwt, exp });
    return jwt;
  };
}

// buildSocialProviders, next to google and microsoft
const mint = appleKey ? appleClientSecretMinter(appleKey) : undefined;
...(mint && auth?.appleClientId
  ? {
      apple: {
        clientId: auth.appleClientId,
        get clientSecret() {
          return mint(auth.appleClientId!);
        },
        appBundleIdentifier: auth.appleAppBundleIdentifier,
        mapProfileToUser: NEVER_TRUST_PROVIDER_EMAIL,
      },
    }
  : {}),
```

The minter takes `sub` as an argument because revocation needs a second secret for the bundle id
(section 5). `buildAccountLinking` derives `trustedProviders` from the keys, so Apple joins it with
no further change. A unit test should pin that the getter survives `betterAuth()`, since a future
release that clones options would freeze the secret at boot without any error.

Also add `https://appleid.apple.com` to `trustedOrigins`. Apple posts the callback
(`responseMode: "form_post"`, `apple.mjs:32`), the router runs `originCheckMiddleware` on every
non-GET request, and `validateOrigin` rejects an untrusted `Origin` whenever the request carries a
cookie (`node_modules/better-auth/dist/api/middlewares/origin-check.mjs:43-45,96-117`). better-auth's
Apple page gives the same instruction [12].

**Env and Terraform**, following `microsoft_client_secret`:

| Env var                       | Terraform variable            | Delivery                                                   |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `APPLE_CLIENT_ID` (Services)  | `apple_client_id`             | plain env in `apprunner.tf`, gates everything else         |
| `APPLE_TEAM_ID`               | `apple_team_id`               | plain env (`S6FC47MMXJ`)                                   |
| `APPLE_KEY_ID`                | `apple_key_id`                | plain env                                                  |
| `APPLE_APP_BUNDLE_IDENTIFIER` | `apple_app_bundle_identifier` | plain env (`com.flexiday.app`)                             |
| `APPLE_PRIVATE_KEY`           | `apple_private_key`           | sensitive; Secrets Manager, then App Runner runtime secret |

In `terraform/secrets.tf`, an `aws_secretsmanager_secret.apple_private_key` with
`count = var.apple_client_id != "" ? 1 : 0` and a version carrying a precondition that the key is
set, like `microsoft_client_secret` at lines 97-122. Add the ARN to the list in `iam.tf` (line 78),
the runtime secret to `apprunner.tf` (next to line 107), and the version to `depends_on` (line 142).
`config.ts` reads the five vars like `microsoftClientId` (lines 312-314). The key is a multi-line
PEM, so the parser should accept literal `\n` too, which is how `.env` files usually carry it.

## 2. Audiences, nonce and the phone

`idToken.audience` is `options.audience` if non-empty, else `appBundleIdentifier` if set, else
`clientId` (`apple.mjs:49`). It is one or the other, not both. With `appBundleIdentifier` set, an id
token whose `aud` is the Services ID fails the id-token path. That is fine for us. The web flow
never runs that check: the callback exchanges the code and `getUserInfo` only decodes the id token
from Apple's token response (`apple.mjs:63-65`, `api/routes/callback.mjs:108-128`). If the web
ever posts an id token directly, set `audience: [servicesId, bundleId]`.

The id-token branch of `/sign-in/social` (`node_modules/better-auth/dist/api/routes/sign-in.mjs:154-213`)
calls `verifyProviderIdToken`, which runs `jose.jwtVerify` against Apple's keys with issuer
`https://appleid.apple.com`, the audience above and `maxTokenAge: "1h"`
(`@better-auth/core/dist/oauth2/verify-id-token.mjs:39-60`). The nonce is checked only if the
client sends one (`verify-id-token.mjs:54`), and Apple's `nonceComparison: "exact-or-sha256"`
accepts the claim as either the raw nonce or its SHA-256 hex. Apple tells servers to verify the
nonce [4], so the phone should always send one. The phone picks it, though, so it binds the token to
the request rather than to a server challenge. The one-hour `maxTokenAge` is the real replay bound.
The branch then requires an email in the profile (`sign-in.mjs:175`); Apple puts the email in the
identity token on every response, while the name comes only the first time [3].

`expo-apple-authentication`'s `signInAsync` takes an optional `nonce` and returns `identityToken`,
`authorizationCode`, `email`, `fullName` and `user` [9]. `email` and `fullName` are non-null only on
the first sign-in, so the phone must pass them as `idToken.user` on that call; better-auth builds the
name from it (`apple.mjs:66-68`, `sign-in.mjs:168`). On the simulator Expo promises only "limited
testing", and `getCredentialStateAsync` always throws there [9].

## 3. Console steps

The team is an Individual membership (`flexi-day-rn/docs/releasing.md:11`), so the account holder
does all of these. Apple lists "Account Holder or Admin" as the required role for enabling App ID
capabilities, Sign in with Apple, creating keys and the email relay [5][6][7][8].

1. **App ID.** Enable Sign in with Apple on `com.flexiday.app` as a primary App ID [5]. Changing an
   App ID makes its provisioning profiles invalid [6].
2. **Services ID.** Identifiers, add, Services ID, then Sign in with Apple, Configure. Pick
   `com.flexiday.app` as the primary App ID and enter domains and return URLs; at least one domain
   is required, and no file upload is needed [7]. Enter `api.flexi-day.com` and
   `https://api.flexi-day.com/api/auth/callback/apple`. Return URLs must be absolute with scheme,
   host and path [4], and Apple rejects `localhost` and IP addresses in `redirect_uri` [2], so the
   web flow cannot be tried against a local backend. Whether `www.flexi-day.com` must be listed as
   well is open (below). An Individual can register up to 10 website URLs [7].
3. **Key.** Keys, add, tick Sign in with Apple, associate it with the primary App ID. Note the Key
   ID. The `.p8` downloads once: "you won't be able to download it again" [8]. Each primary App ID
   takes at most two keys, which is what makes rotation possible: create the second, switch, revoke
   the first [4][8].
4. **Private email relay.** Services, "Sign in with Apple for Email Communication", Configure, Email
   Sources [10]. Register the domain `flexi-day.com` and the address `no-reply@flexi-day.com`
   (`terraform/variables.tf:127-130`). Apple wants every registered domain to pass SPF or DKIM. For
   SPF, the envelope sender domain must match the registered domain exactly; for DKIM, the `d=`
   domain must match the header From domain [10]. SES uses an `amazonses.com` subdomain as MAIL
   FROM unless a custom one is set [11], and this repo sets none, so SPF cannot match. DKIM can:
   `flexi-day.com` has Easy DKIM (`flexi-day-emails/terraform/email-forwarding.tf:7`). Apple's
   console shows the SPF result per source [10]. The apex SPF record is
   `v=spf1 include:amazonses.com ~all` when `manage_spf_record` is on (`email-forwarding.tf:42-53`).
5. **EAS.** Add `"usesAppleSignIn": true` under `ios` and `"expo-apple-authentication"` to
   `plugins` in `app.json` [9]. The first `eas build` after that must run interactively so EAS
   syncs the capability and replaces the now-invalid App Store profile, exactly as with Associated
   Domains (`flexi-day-rn/docs/releasing.md:65-82`). The push caveat there applies too: without
   `EXPO_NO_CAPABILITY_SYNC=1`, that build also turns Push Notifications off on the App ID.

## 4. Profile facts

`getUserInfo` decodes the id token, takes the name from `token.user` if present, derives
`emailVerified` from `email_verified`, then spreads the `mapProfileToUser` result last
(`apple.mjs:60-84`). All three entry points call it: the web callback (`callback.mjs:120`),
id-token sign-in (`sign-in.mjs:170`) and id-token linking (`api/routes/account.mjs:172`). A probe
with `email_verified: true` and `mapProfileToUser: () => ({ emailVerified: false })` returned
`emailVerified: false`, with and without the first-time `user` object. On later sign-ins the name
comes back as an empty string.

Apple shares the name and email only on the first authorization and again only if the user stops
using Sign in with Apple and reconnects [3]. A user who hides their email gets a relay address, shown in Apple's
examples as `...@privaterelay.appleid.com` [9][18]. Consequences under the current invariants
(`docs/invariants.md`, "Account linking is explicit only"):

- Signing in with a relay address never meets an existing account, so it always creates a new,
  unverified one. It never produces `account_not_linked`.
- "Connect Apple" from Settings fails for a hidden-email user. With `allowDifferentEmails` off, the
  redirect flow returns `EMAIL_DOES_NOT_MATCH` (`oauth2/link-account.mjs:47`) and the id-token flow
  returns `LINKING_DIFFERENT_EMAILS_NOT_ALLOWED` (`account.mjs:208-213`).
- The confirmation email and every later notification go to the relay address, which delivers only
  once step 4 above is done.

## 5. Token revocation on account deletion

Guideline 5.1.1(v) requires in-app account deletion for apps that create accounts [13]. The text of
the guideline does not mention Apple tokens. The revocation duty comes from Apple's account deletion
page: apps that use Sign in with Apple "should use the Sign in with Apple REST API to revoke user
tokens" [14].

The call is `POST https://appleid.apple.com/auth/revoke`, form-encoded, with `client_id`,
`client_secret`, `token` and `token_type_hint` of `refresh_token` or `access_token`. It answers 200
for a revoked or already invalid token. `client_id` "must match the value provided during the
authorization request" [2]. Without either token, Apple says to get one by validating an
authorization code [2], which is single-use and valid for five minutes [15].

What better-auth stores:

- **Web.** The callback spreads the token response into the account data (`callback.mjs:150-153`)
  and the account row gets `refreshToken`. Apple returns a refresh token on the code exchange [15],
  and it stays valid until the user revokes access or changes their password [4]. `auth.ts` does not
  set `encryptOAuthTokens`, so it sits in plaintext.
- **Phone.** The id-token sign-in writes only `accessToken` from the request body and the
  `idToken` (`sign-in.mjs:189-194`). The Expo credential carries no access or refresh token [9],
  so the row holds nothing revocable. The phone does get an `authorizationCode` [9]. Exchanging it
  needs `client_id = com.flexiday.app` and a secret with that `sub` [1][15], which is why the minter
  takes `sub`. The linking route does store a `refreshToken` passed in the body
  (`account.mjs:196,221`); sign-in does not.

Each row's stored `idToken` carries the `aud` it was issued for, so the deletion code can pick the
right `client_id` and secret. Account rows cascade with the user (`docs/account-deletion.md`, "What
goes and what stays"), so the token has to be read before the transaction deletes them. The call
belongs after the commit, next to `deleteStoredBytes`. A refused deletion then revokes nothing, and
a failed revoke is logged while the request still answers 204. Apple-only users would also join the
`recent-sign-in` confirmation row, which today names only Google and Microsoft.

## 6. Web button

Apple's JS (`appleid.auth.js`, a `div#appleid-signin` wrapper) renders a system button [16], but
better-auth's redirect flow needs only a link to `/sign-in/social`, so a custom button is allowed.
For a custom button the HIG requires [17]:

- Apple's logo artwork from Apple Design Resources, never a redrawn logo, never the logo alone as a
  button, not cropped, height matched to the button.
- Title "Sign in with Apple", "Sign up with Apple" or "Continue with Apple" only.
- Logo and title both black or both white, on a black or white background.
- Font, weight, size, all-caps, corner radius, bezel and shadow may change.
- At least 140pt wide, 30pt tall, a margin of one tenth of the height around it, and at least 8% of
  the width between title and right edge.
- No smaller than the other sign-in buttons, and visible without scrolling. App Review evaluates
  custom buttons.

## Open questions

- **Services ID domains.** Apple asks to "register and verify all top-level domains and subdomains
  that incorporate Sign in with Apple" [4] but does not say whether the page hosting a plain link
  counts. `api.flexi-day.com` plus the return URL covers the redirect flow as written; adding
  `www.flexi-day.com` costs one of ten slots and removes the doubt.
- **App Store prerequisite.** Apple's environment guide says web sign-in needs "an existing app in
  the App Store that uses Sign in with Apple" [4]. Flexi Day ships through TestFlight. Whether the
  portal enforces this before release is not stated.
- **Simulator.** Expo promises only limited simulator support [9]. Whether `signInAsync` returns a
  verifiable identity token on the simulator in this dev loop needs a try.
- **Nonce on the wire.** Expo does not say whether it hashes the nonce before handing it to Apple.
  better-auth accepts either form, so this blocks nothing.
- **Phone revocation design.** Exchange the `authorizationCode` at sign-in and store the refresh
  token (a custom endpoint or hook, since `/sign-in/social` ignores the code), or ask the phone for
  a fresh code at deletion time, which needs another Apple prompt. No primary source decides this.
- **PEM in App Runner.** Whether a multi-line Secrets Manager value reaches the process with real
  newlines was not checked; parsing both forms avoids the question.
- **Server-to-server notifications.** Apple can notify an endpoint when a user deletes their Apple
  account or changes relay forwarding [4][18]. Out of scope here.

## Sources

1. Apple, Creating a client secret.
   https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
2. Apple, Revoke tokens. https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
3. Apple, Authenticating users with Sign in with Apple.
   https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
4. Apple, Configuring your environment for Sign in with Apple, and Verifying a user.
   https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
   https://developer.apple.com/documentation/signinwithapple/verifying-a-user
5. Apple Account Help, About Sign in with Apple.
   https://developer.apple.com/help/account/capabilities/about-sign-in-with-apple
6. Apple Account Help, Enable app capabilities.
   https://developer.apple.com/help/account/identifiers/enable-app-capabilities
7. Apple Account Help, Configure Sign in with Apple for the web.
   https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web
8. Apple Account Help, Create a private key to access a service, and Create a Sign in with Apple
   private key. https://developer.apple.com/help/account/keys/create-a-private-key
   https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key
9. Expo SDK 57, AppleAuthentication.
   https://docs.expo.dev/versions/v57.0.0/sdk/apple-authentication/
10. Apple Account Help, Configure private email relay service.
    https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service
11. AWS, Using a custom MAIL FROM domain. https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
12. better-auth, Apple. https://www.better-auth.com/docs/authentication/apple
13. Apple, App Store Review Guidelines, 5.1.1(v).
    https://developer.apple.com/app-store/review/guidelines/
14. Apple, Offering account deletion in your app.
    https://developer.apple.com/support/offering-account-deletion-in-your-app/
15. Apple, Generate and validate tokens.
    https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
16. Apple, Displaying Sign in with Apple buttons on the web.
    https://developer.apple.com/documentation/signinwithapple/displaying-sign-in-with-apple-buttons-on-the-web
17. Apple, Human Interface Guidelines, Sign in with Apple.
    https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
18. Apple, Processing changes for Sign in with Apple accounts.
    https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts

Code read, under `flexi-day-be/`: `node_modules/@better-auth/core/dist/social-providers/apple.mjs`;
`node_modules/@better-auth/core/dist/oauth2/` (`validate-authorization-code`, `refresh-access-token`,
`token-endpoint-auth`, `verify-id-token`, `utils`); `node_modules/better-auth/dist/` (`context/create-context`,
`api/routes/sign-in`, `callback`, `account`, `api/middlewares/origin-check`, `oauth2/link-account`);
`src/utils/socialProviders.ts`, `src/utils/auth.ts`, `src/config.ts`, `terraform/*.tf`,
`docs/invariants.md`, `docs/account-deletion.md`, `../flexi-day-rn/docs/releasing.md`,
`../flexi-day-rn/app.json`, `../flexi-day-emails/terraform/email-forwarding.tf`.
