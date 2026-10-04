# Microsoft sign-in on the iPhone as an Entra public client

Researched 2026-10-04 against better-auth 1.7.6 (`node_modules`), `expo-auth-session` 57.0.13 (the
`sdk-57` branch of `expo/expo`) and Microsoft Learn as published on that date.

## Answer

Yes. better-auth 1.7.6 accepts an id token issued through `common`. With `tenantId: "common"` it
fetches keys from `https://login.microsoftonline.com/common/discovery/v2.0/keys`, passes no fixed
issuer to jose, and then its own `verifyClaims` requires `iss` to equal
`https://login.microsoftonline.com/{tid}/v2.0` for the token's own `tid`. That is the shape
Microsoft issues for work accounts and for personal accounts (`tid`
`9188040d-6c67-4c5b-b112-36a304b66dad`). No tenant pin, no patched verifier, no `getUserInfo`
override. One catch: the web sign-in that works today never runs this check, because the OAuth
callback decodes the token it fetched itself without verifying it. The first phone sign-in is the
first time this code meets a real Microsoft token, so test one work account and one personal account
before shipping.

The rest holds with a few conditions. The audience check is `options.clientId`, which a public
client on the same registration receives as `aud`. A nonce is checked only when the request body
carries one. `mapProfileToUser` runs on the id-token path and its `emailVerified: false` overrides
whatever better-auth derived. On the phone, `expo-auth-session` does PKCE by default, runs in
`ASWebAuthenticationSession`, has no config plugin, and needs only the `flexiday` scheme the app
already declares. In Entra, add a Mobile and desktop applications platform with `flexiday://auth`,
leave "Allow public client flows" off, and change nothing on the Web platform or the secret. Drop
`offline_access`. Conditional access that demands an approved app or an app protection policy blocks
the phone, and it blocks Safari on that iPhone just the same, so recording it as a known limitation
is fair.

## 1. Issuer and JWKS with `common`

The provider is `@better-auth/core/dist/social-providers/microsoft-entra-id.mjs`. `tenant` falls
back to `"common"` (line 19), and the id-token config reads (lines 71-95):

```js
jwks: (header) => getMicrosoftPublicKey(header.kid, tenant, authority),
audience: options.clientId,
maxTokenAge: "1h",
issuer: tenant !== "common" && tenant !== "organizations" && tenant !== "consumers" ? `${authority}/${tenant}/v2.0` : void 0,
verifyClaims: (claims) => {
  const tid = claims.tid;
  if (typeof tid !== "string" || claims.iss !== `${authority}/${tid}/v2.0`) return false;
  // two more lines restrict tid for "organizations" and "consumers" only
  return true;
}
```

`getMicrosoftPublicKey` fetches `${authority}/${tenant}/discovery/v2.0/keys` (line 155) on every
verification, with no cache. With the defaults that is
`https://login.microsoftonline.com/common/discovery/v2.0/keys`, the same `jwks_uri` Microsoft's
`common` discovery document publishes. On 2026-10-04 that key set held every `kid` from both the
`organizations` and the `consumers` sets, so either account class's token finds its key.

`@better-auth/core/dist/oauth2/verify-id-token.mjs` then runs (lines 48-55):

```js
const { payload } = await jwtVerify(token, config.jwks, {
  issuer: config.issuer,
  audience: config.audience,
  algorithms: config.algorithms ?? (alg ? [alg] : void 0),
  maxTokenAge: config.maxTokenAge,
});
if (nonce && !(await nonceMatches(payload.nonce, nonce, config.nonceComparison))) return false;
if (config.verifyClaims && !config.verifyClaims(payload)) return false;
```

With `issuer` undefined, jose checks signature, `aud`, `exp` and token age only, and `verifyClaims`
does the issuer work. Microsoft's ID token reference says `iss` "identifies the tenant for which the
user was authenticated", ends in `/v2.0` from the v2.0 endpoint, and that the consumer GUID is
`9188040d-...`. It defines `tid` as the tenant the user signs in to, with the same GUID for personal
accounts. The `common` discovery document advertises `issuer` as
`https://login.microsoftonline.com/{tenantid}/v2.0`, and the `consumers` one resolves it to
`.../9188040d-6c67-4c5b-b112-36a304b66dad/v2.0`. A token from either class therefore satisfies
`iss === authority/tid/v2.0`. better-auth handles `common`. It does not reject these tokens. The
web path proves none of this: `callback.mjs` never calls `verifyProviderIdToken`, only `sign-in.mjs`,
`account.mjs` (link-social with an id token) and the generic-oauth plugin do.

If a real token ever fails here, the options in order of cost:

- `MICROSOFT_TENANT_ID` set to one directory GUID fixes `issuer` with one env var, and locks out
  every other organization and all personal accounts, web included. Not viable here.
- A `verifyIdToken` option on the provider. `verifyProviderIdToken` calls it in place of the built-in
  check (line 42). About 20 lines with jose, but Flexi Day then owns signature, audience and issuer
  checks for the phone path and must keep them current.
- A `getUserInfo` override does not help. It runs after verification (`sign-in.mjs` line 170), so it
  cannot rescue a token the verifier refused.

## 2. Audience, nonce and `emailVerified`

Audience is `options.clientId` (line 72 above), the `MICROSOFT_CLIENT_ID` value. Microsoft's
reference says an id token's `aud` is "your app's Application ID". A public client on the same
registration shares that client id, so its tokens pass.

The `/sign-in/social` id-token branch is `better-auth/dist/api/routes/sign-in.mjs` lines 154-188.
It reads `const { token, nonce } = c.body.idToken;` (line 159) and verifies with that nonce
(line 160). The body schema marks `nonce` optional (line 68), and the verifier compares only
`if (nonce && ...)`. A nonce is checked when present and never required. `idToken` is an object,
not a string, so the call is `authClient.signIn.social({ provider: "microsoft", idToken: { token } })`.

Sending a nonce buys little. The phone mints it and better-auth never sees it beforehand, so a thief
replaying a stolen token just leaves it out. `maxTokenAge: "1h"` is the real replay bound.
`AuthRequest.ts` and `TokenRequest.ts` in `expo-auth-session` never mention a nonce, so adding one
means `extraParams: { nonce }` on the request. I'd skip it.

`mapProfileToUser` runs on this path. Line 170 calls `provider.getUserInfo(oauthTokens)`, which
decodes the id token, calls `options.mapProfileToUser?.(user)` (provider line 118) and builds the
user with `emailVerified` first and `...userMap` last (lines 121-126), so
`NEVER_TRUST_PROVIDER_EMAIL` in `src/utils/socialProviders.ts` wins. `sign-in.mjs` line 188 then
passes `userInfo.user.emailVerified || false` on. The invariant in `docs/invariants.md` ("Social
sign-in never confers a verified address") holds. Account linking goes through the same
`handleOAuthUserInfo` the web callback uses, so `disableImplicitLinking` applies too.

A token with no `email` claim fails with `USER_EMAIL_NOT_FOUND` (lines 175-178), as on the web.
Don't send `accessToken`: `getUserInfo` would spend it on a Graph photo call (provider line 106) and
the account row would store it (line 192).

## 3. `expo-auth-session` on SDK 57

- Install `expo-auth-session` and `expo-crypto` (SDK 57 AuthSession page). The package has no
  native code and no `app.plugin.js` on `sdk-57`. Its dependencies `expo-crypto`,
  `expo-web-browser`, `expo-linking`, `expo-application` and `expo-constants` are already in
  `flexi-day-rn/package.json`.
- Configuration is a `scheme` in app config, nothing else. `flexi-day-rn/app.json` already has
  `"scheme": "flexiday"`.
- `useAutoDiscovery("https://login.microsoftonline.com/common/v2.0")` fetches
  `${issuer}/.well-known/openid-configuration` (`Discovery.ts` line 211) and takes
  `authorization_endpoint` and `token_endpoint` from it, which for `common` are
  `.../common/oauth2/v2.0/authorize` and `.../common/oauth2/v2.0/token`.
- `responseType` defaults to `code` and `usePKCE` to `true`, with S256 (`AuthRequest.ts` lines
  66, 74, 76). The verifier is generated before the URL is built (line 113).
- `makeRedirectUri({ scheme: "flexiday", path: "auth" })` gives `flexiday://auth`, per the Expo
  guide's `your.app://redirect` pattern.
- `exchangeCodeAsync` does not send the PKCE verifier by itself. Pass it as
  `extraParams: { code_verifier: request.codeVerifier }`. With no `clientSecret` the body carries
  `client_id` (`TokenRequest.ts` line 266), and the response maps `id_token` to `idToken` (line 252).

The browser is `ASWebAuthenticationSession`. `promptAsync` calls `WebBrowser.openAuthSessionAsync`
(`AuthRequest.ts` line 179), and `expo-web-browser/ios/WebAuthSession.swift` builds an
`ASWebAuthenticationSession` with `callbackURLScheme` (lines 53-57). Microsoft's MSAL docs count it
as a system browser that shares cookies with Safari, and MSAL defaults to it on iOS 12+. Google's
native-app guide disallows `WKWebView` and points iOS developers at AppAuth, which uses
`ASWebAuthenticationSession` too. RFC 8252 section 8.12 bars embedded user-agents in native apps. Apple adds that only
the calling app's session receives the callback, even when other apps register the same scheme.
Expo Go cannot run this because it cannot customize the scheme (Expo guide). The dev client can.

## 4. Entra portal steps

1. App registrations, Flexi Day, Authentication, Add Redirect URI, **Mobile and desktop
   applications**, custom redirect URI `flexiday://auth`. Microsoft's reply-URL guide says iOS apps
   "implementing our OAuth protocols directly" or using AppAuth belong on this platform, not on
   iOS / macOS. `msauth.com.flexiday.app://auth` is the MSAL and broker format that the iOS / macOS
   platform generates. It brings nothing without MSAL and would need a second URL scheme in the
   app. Keep the URI free of query parameters, which registrations that admit personal accounts
   reject.
2. Leave **Allow public client flows** at No. Microsoft lists only Native Authentication, device
   code, ROPC and Windows Integrated Auth as reasons to turn it on, and says it "should be disabled"
   otherwise. A PKCE code flow is not on that list.
3. Redeeming the code without a secret works because the redirect URI is the public-client type.
   Microsoft: public clients "must not use secrets or certificates when redeeming an authorization
   code", and redirect URIs should "include the type of application". If the URI lands on the Web
   platform by mistake, the token endpoint answers `AADSTS7000218` (missing `client_secret`). If the
   phone ever sent a secret to a public redirect, it gets `AADSTS700025`.
4. The `email` optional claim already covers the phone. Optional claims are set "on a per-application
   basis", and the phone uses the same application. Requesting the `email` scope gets the claim too,
   with "you don't need to request both". The claim is absent when the account has no address, and
   better-auth then refuses, exactly as on the web.
5. Leave the implicit-flow "ID tokens" box alone. With `openid` in scope the token endpoint returns
   `id_token` from a plain code redemption.
6. The Web platform, its redirect, the client secret, the backend env vars and Terraform stay as
   they are.

## 5. Conditional access

Microsoft's grant controls differ, and only some of them hit the phone:

- **Require approved client app** and **Require app protection policy** pass only for apps on
  Microsoft's lists or built with Intune app protection. Flexi Day is neither, with or without a
  broker, so tenants enforcing these on iOS block the phone. Microsoft also says Safari "can't
  satisfy" either control. The web app in Safari on that iPhone is blocked too, while Edge
  satisfies both. The approved-app grant is retiring in favour of app protection policy.
- **Require device to be marked as compliant** works in Safari on a managed device. Apps that don't
  use MSAL get device identity through the Microsoft Enterprise SSO plug-in, which "passes the device
  certificate to satisfy the device-based Conditional Access check" for apps an administrator adds
  to `AppAllowList`, or for all MDM-managed apps with `Enable_SSO_On_All_ManagedApps`. Microsoft
  also notes the plug-in "must be enabled for applications that do not use" MSAL, Safari included,
  once device keys live in the Secure Enclave.
- The client apps condition counts OAuth confidential clients as "Browser". The phone's public
  client sign-in presumably falls under "Mobile apps and desktop clients", so a tenant that blocks
  mobile apps and allows browsers would stop the phone and not the web.

Calling this a known limitation is sound. App protection policies shut out every non-Intune app,
Safari included, so a native broker would not rescue the phone. Compliant-device tenants can admit
the app with one allowlist entry. A business customer under such a policy can still use the web in
Edge.

## 6. Refresh tokens

Microsoft returns `refresh_token` from the code redemption "only if `offline_access` scope was
requested", and v2.0 apps "must explicitly request" it. Drop `offline_access` from the phone's
scopes and no refresh token exists to store or leak. Should one arrive anyway, keep it in memory
only, never send it to better-auth, and let it go out of scope. Microsoft calls refresh tokens
sensitive data meant only for the authorization server. The `sign-in.mjs` id-token branch would
not store it anyway: the account row gets `accessToken` and `idToken` only (lines 190-194).

Dropping the scope changes no consent screen, since Microsoft says `offline_access` "currently
appears on all consent pages". The backend's own scope list for the web flow (provider lines
38-44) keeps `User.Read` and `offline_access` and is untouched.

## Open questions

- **A real token through `verifyClaims`.** The source reading says both account classes pass, but
  nothing in the repo has run it. Sign in once with a work account and once with a personal account
  against a dev backend before release.
- **`flexiday://auth` in the portal.** Microsoft says the Mobile and desktop platform takes
  "Custom redirect URIs" but never lists allowed schemes, and its general rule ("must begin with the
  scheme `https`") reads as a Web rule. MSAL's own `msauth.` URIs prove custom schemes work on public
  platforms. Confirm when entering it.
- **Compliant-device tenants without allowlisting.** The plug-in allows `com.apple.SafariViewService`
  by default and lists `ASWebAuthenticationSession` among bootstrapping sources, but no source says
  whether a session started by `com.flexiday.app` counts as Safari or as the app. If it counts as
  the app, the customer's admin must add `com.flexiday.app` to `AppAllowList`.
- **Client-apps classification** of the phone sign-in, as inferred in section 5.
- **The iOS simulator.** No primary source says `ASWebAuthenticationSession` works or fails there.
  Expo's AuthSession page tells you to test the scheme on an emulator, and the workspace already
  runs this dev client on the simulator. Confirm on the first run.

## Sources

Code, read locally or at the `sdk-57` tag:

- `flexi-day-be/node_modules/@better-auth/core/dist/social-providers/microsoft-entra-id.mjs` and
  `.../oauth2/verify-id-token.mjs` (1.7.6)
- `flexi-day-be/node_modules/better-auth/dist/api/routes/sign-in.mjs` and `callback.mjs`
- `flexi-day-be/src/utils/socialProviders.ts`, `flexi-day-be/docs/invariants.md`,
  `flexi-day-rn/app.json`, `flexi-day-rn/package.json`
- https://github.com/expo/expo/tree/sdk-57/packages/expo-auth-session (`src/AuthRequest.ts`,
  `src/TokenRequest.ts`, `src/Discovery.ts`, `package.json`) and
  https://github.com/expo/expo/blob/sdk-57/packages/expo-web-browser/ios/WebAuthSession.swift
- https://github.com/openid/AppAuth-iOS/blob/master/Sources/AppAuth/iOS/OIDExternalUserAgentIOS.m

Live, fetched 2026-10-04: `https://login.microsoftonline.com/{common,consumers}/v2.0/.well-known/openid-configuration`
and `https://login.microsoftonline.com/{common,organizations,consumers}/discovery/v2.0/keys`.

Microsoft Learn, all under `https://learn.microsoft.com/en-us/entra/`:

- `identity-platform/`: `id-token-claims-reference`, `v2-protocols`, `v2-protocols-oidc`,
  `v2-oauth2-auth-code-flow`, `scopes-oidc`, `optional-claims-reference`, `how-to-add-redirect-uri`,
  `reply-url`, `msal-client-applications`, `scenario-mobile-app-configuration`,
  `reference-error-codes`, `apple-sso-plugin`
- `msal/objc/customize-webviews`
- `identity/conditional-access/`: `concept-conditional-access-grant`,
  `concept-conditional-access-conditions`

Others:

- Expo: https://docs.expo.dev/versions/v57.0.0/sdk/auth-session/ and
  https://docs.expo.dev/guides/authentication/
- Apple: https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession
- Google: https://developers.google.com/identity/protocols/oauth2/native-app
- RFC 8252: https://www.rfc-editor.org/rfc/rfc8252
