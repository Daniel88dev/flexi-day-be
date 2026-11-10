# Invariants

Rules that hold across `flexi-day-be` and must survive every change. Each entry says what breaks
if it is undone; most are covered by a test that fails on regression.

## Authentication (`src/utils/auth.ts`)

Better Auth with email/password, mandatory email verification, password reset by email
(`password-reset` SES template), Have I Been Pwned checks, a Drizzle session adapter, and its own
rate limit (50 requests / 10s) on top of `credentialsLimiter`.

- **Social sign-in never confers a verified address; an invite link does.** `buildSocialProviders`
  maps every Google, Microsoft and Apple profile to `emailVerified: false`. Google's and Microsoft's
  claims attest the _domain_, not the mailbox, and Apple gets the same rule rather than an exception
  of its own. Two things verify an address: our own confirmation email, and following an invite
  link. Redeeming an email-bound **invite code** requires a verified address
  (`handlePostGroupUser`), because the admin knows the code and knowing it proves nothing about the
  mailbox. The **invite link** is different: its secret is generated at issue time, stored only as a
  SHA-256 hash, returned by no API and sent only to the invited address, so holding it is the proof.
  `handlePostInviteJoin` therefore requires a session whose address matches the invite, and marks
  that address verified in the same transaction as the join. `handlePostInviteSignUp` is the same
  proof for an invitee with no account: it creates the password account through better-auth's own
  sign-up, then verifies it in the join's transaction. The confirmation email is switched off by
  `withoutConfirmationEmail` (`src/utils/confirmationEmail.ts`), an async-context flag only that
  handler sets, never a header or body field a client could send. Without this split, an
  identity-provider administrator who asserts a colleague's address could join that colleague's
  team with the code, and a legitimately invited Google, Microsoft or Apple user could not join at
  all.

  Verifying by link deliberately has **no settle step**: unlike a password reset, it leaves the
  account's provider links in place. On an unverified account every provider link was attached by
  whoever holds its session, either by the sign-in that created it or from inside that session,
  since implicit linking is off (next entry). That same session has now also presented the
  mailbox's secret, so both proofs point at one person and there is nobody to evict. A reset is
  different because it proves the mailbox _without_ a session, so the links it finds may belong to
  someone else. Sign-up with invite needs no such step at all: the account is new, so it has no
  provider links.

  better-auth cannot join our transaction, so sign-up with invite checks everything that can refuse
  first: an open invite for this address, no existing account, a free seat. The account is created
  unverified, and a join that still fails deletes it. The residual race is a concurrent redemption
  landing between those checks and the join; the join then refuses and the account goes. If that
  delete fails as well, what is left is an ordinary unconfirmed sign-up, never a verified account
  outside the group. Refusing an existing address with a real error, where normal sign-up answers a
  made-up success, reveals nothing, because every invite check runs first and only the secret's
  holder gets that far. `src/tests/e2e/inviteLink.e2e.test.ts` covers the link,
  `src/tests/e2e/inviteSignUp.e2e.test.ts` sign-up with invite and
  `src/tests/e2e/inviteRedemption.e2e.test.ts` the code.

- **Account linking is explicit only.** `accountLinking` trusts every configured provider (Google,
  Microsoft, Apple), derived from `buildSocialProviders` so an unconfigured one is never listed.
  That trust is needed at all because the false `emailVerified` above would otherwise block every
  link. It then sets `disableImplicitLinking`, so a provider can only be attached from a signed-in
  session via `POST /link-social` (Settings → Sign-in methods). Without that flag, a directory
  administrator could set a mail attribute to someone else's address and sign straight into their
  account. Keep `allowDifferentEmails` and `allowUnlinkingAll` off;
  `src/tests/utils/accountLinking.test.ts` fails if any of this is undone.
- **Social sign-in does not run the second factor.** The `twoFactor` plugin's hook matches only
  `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`. A Google, Microsoft or Apple
  sign-in, whether through the web callback or the phone's id token at `/sign-in/social`, therefore
  mints a session without our code even when `twoFactorEnabled` is on. That is a deliberate
  exception, not an equivalent control: a Google or Microsoft account can run with no second step
  at all, so a linked provider can be a way in with no second factor anywhere. Our second factor
  guards the password, not the account, and every provider linked to an account skips it. If a
  better-auth upgrade widened the matcher, social users with two-factor on would start meeting our
  code challenge without anyone deciding they should; if it narrowed it, a password sign-in would
  get through without its code. Putting a social path under the plugin is a product decision, not a
  fix.
  The same holds for AI connections: an OAuth grant that starts with a social sign-in on the connect
  sign-in page carries the signed query through the provider and reaches the organization picker
  with no code challenge, so the grant is as single-factor as that sign-in.
  `src/tests/utils/twoFactorScope.test.ts` fails if the matcher moves either way.
- **The Expo authorization proxy stays disabled.** `disabledPaths` in `auth.ts` lists
  `/expo-authorization-proxy`. The `expo()` plugin serves it to start a browser sign-in from the
  phone, and it redirects to any https URL its query names, an open redirect on the API's own
  domain. Nothing needs it: the phone signs in by posting the provider's id token to
  `/sign-in/social`. `src/tests/utils/expoAuthorizationProxy.test.ts` fails if the entry goes, and
  "does not serve the plugin's authorization proxy" in `src/tests/e2e/expoOrigin.e2e.test.ts` checks
  the route answers 404.
- **Phone id tokens are verified by our own verifier.** `buildSocialProviders` gives Google,
  Microsoft and Apple a `verifyIdToken` from `src/utils/idTokenVerifier.ts`, backed by a cached
  `jose` key set per provider. Once a provider has that option, better-auth runs no other check on
  a token posted to `/sign-in/social` or `/link-social`, so issuer, audience, RS256, the one-hour
  maximum age and the nonce all live in that file, and loosening one there loosens sign-in. A
  provider left without the option falls back to better-auth's stock check, which downloads the key
  set on every sign-in, and Microsoft tokens stop verifying at all, because Microsoft publishes its
  keys without an `alg` and the stock import refuses them. The "phone id tokens" block in
  `src/tests/utils/socialProviders.test.ts` runs each provider through better-auth's own
  `verifyProviderIdToken` and fails if any of this is undone.
- **OAuth tokens are encrypted at rest.** `account.encryptOAuthTokens` is on, so better-auth
  encrypts every access and refresh token it writes with the auth secret, and the Apple
  authorization route writes its tokens through the same helper (`src/utils/oauthTokens.ts`).
  Rows written before it went on still hold plaintext, and `decryptOAuthToken` passes them through
  because they do not look encrypted, so there is no migration. Code that reads a token straight
  from the `account` table must decrypt it with that helper. Turning the option off would leave
  every encrypted row unreadable, and a database dump of plaintext refresh tokens is a sign-in for
  each social user, since a refresh token yields fresh id tokens the phone's sign-in accepts.
  `src/tests/utils/oauthTokenEncryption.test.ts` fails if the option goes or a plaintext row stops
  reading.
- **The Apple authorization route is the only writer of a phone link's refresh token.** A phone
  Apple sign-in posts an id token and nothing else, so better-auth stores no refresh token for it;
  `POST /api/users/me/apple-authorization` exchanges the sign-in's one-time code and stores one.
  A later id-token sign-in must leave it in place: better-auth drops undefined fields from the
  account update, and if an upgrade started writing them as null, deletion would have nothing to
  revoke at Apple. `src/tests/utils/appleRepeatSignIn.test.ts` fails if a repeat sign-in clears
  the stored token.
- **An Apple link is revoked at Apple when it goes.** Deleting the account and disconnecting Apple
  in Settings both revoke the link's refresh token at Apple. It is best effort: a revoke that fails
  or cannot be made is logged, and never refuses either action or changes its answer. The token is
  read while the row still exists, and the unlink revokes only once it succeeded.
  [`account-deletion.md`](account-deletion.md#apple-links) has the sequence and the rules.
  `src/services/appleAuthorization/tests/appleRevocation.test.ts` pins the call,
  `src/controllers/users/tests/accountDeletion.test.ts` the order around the commit, and
  `src/tests/utils/appleUnlinkRevocation.test.ts` runs a real better-auth unlink and fails if the
  `apple-unlink-revocation` plugin leaves `auth.ts`.
- **A completed password reset settles the account.** `onPasswordReset` marks the address verified
  and, when it was _not_ already verified, deletes every non-`credential` `account` row in the same
  transaction. Both halves are deliberate. Verifying is what makes the new password usable at all
  (`requireEmailVerification` would otherwise reject it, and social sign-up never verifies). Deleting
  is what stops the promotion being an escalation: an unverified row can have been created by a
  provider asserting an address nobody confirmed, social sign-in is not gated on verification, so a
  surviving link would hand that account — now verified — straight back to whoever planted it. The
  cost is that a legitimate social-only user who never confirmed their address loses their provider
  link on reset; the reset email says so, and Settings → Sign-in methods reconnects it.
  `src/tests/e2e/passwordResetSettles.e2e.test.ts` covers this.
- **Sign-up with team touches only the account it created.** better-auth answers an address that
  already has an account with a made-up success, so `handleSignUpWithTeam` treats the user as new
  only when no account had the address before the call and the returned id is a saved row with
  that address. Anything else creates no team and gets the same 201 as a sign-up without a team
  name. Rolling back a failed team deletes only the row with that new id and the address, and its
  verification rows only when that row went.
  `src/tests/e2e/signUpWithTeam.e2e.test.ts` covers this.
- **A native session only answers to the device that opened it.** The path-agnostic `hooks.before`
  in `auth.ts` reads the session row behind the request's cookie, and when that row carries a
  `device_id` the request's `x-client-device-id` does not match — a different id, a malformed one
  (the header helper drops it, so it reads as absent), or none at all — deletes the row, logs
  `session.device_mismatch` with both ids, and answers 401 with code `SESSION_DEVICE_MISMATCH`.
  Deleting rather than refusing is what protects a ten-year row: a bounced request could be retried
  with the right id, so a stolen cookie would cost one guess. The code is the contract with the
  phone app, which wipes its local store on it, so `authSession` translates the same error for the
  app's own routes rather than letting `errorMiddleware` answer 500 — as `code` at the body root
  from better-auth, under `errors[0].context.code` from `/api`. A null `device_id` — every web and
  every dev-login session — ignores the header in every combination, so a stray header from a
  browser can never sign anyone out. The columns are `input: false` session fields the create hook
  alone writes, so no request body can set them. `src/tests/e2e/nativeSession.e2e.test.ts` fails if
  the hook goes: "on every later request" covers the mismatch, both unusable headers, the protected
  `/api` route, the untouched web and dev-login sessions and the warning, and "ignores a sign-in
  body that tries to stamp the fields itself" covers the body.
  "changing the password" fails if a password change from the phone stops leaving one new row
  stamped with its device id and ten-year expiry behind a re-issued cookie, or one from the web
  stops ending the phone's session: `/change-password` with `revokeOtherSessions` deletes every row
  and creates one new session, and only the create hook and the path-agnostic `hooks.after` keep
  the phone signed in.
  `src/tests/utils/nativeSession.test.ts` ("the device check") pins the predicate on its own.
- **One phone holds one session.** A completed native sign-in deletes every other session row
  carrying the same `device_id` — keyed on the device and not the user, so signing in as someone
  else on that phone replaces the session too. The hook that does it is registered as a plugin
  hook _after_ `twoFactor`, and has to stay there: better-auth runs the user-level `hooks.after`
  before every plugin's, and from there a two-factor sign-in cannot be told from a completed one —
  `twoFactorRedirect` is not in the body yet and the throwaway pre-challenge session is still
  `newSession` — so evicting from the user hook would end the phone's real session the moment a
  challenge started, and abandoning the code would cost the person their session.
  `src/tests/e2e/nativeSession.e2e.test.ts` fails if the eviction or its placement goes: "takes the
  earlier session's place", "leaves the other phone signed in", "replaces the session on the phone
  even when someone else signs in" and "stands through a challenge, and is replaced by the session
  that ends it". `src/tests/utils/nativeSession.test.ts` ("one session per device") pins the
  predicate on its own.
- **The auth secret rotates by version, and every boot moves encrypted rows onto the newest.**
  `src/config.ts` reads `BETTER_AUTH_SECRETS` (`<version>:<secret>` pairs, newest first), or a lone
  `BETTER_AUTH_SECRET` as version 1. `src/utils/auth.ts` gives better-auth the list and version 1
  as the key for ciphertext from before versioning, which names no version. better-auth encrypts
  under the newest version, tags the ciphertext `$ba$<version>$`, and decrypts with whichever
  version the tag names. That covers TOTP secrets, backup codes, account OAuth tokens, calendar
  tokens and `jwks.private_key`, the key that signs AI connections' access tokens (`jwt()` stores
  it as the ciphertext wrapped in a JSON string, so its sweep entry unwraps and rewraps it). Terraform keeps two versions, so a row still under the older one when the next rotation
  lands never reads again, and for a dormant user's TOTP secret that is a lockout. Re-encrypting on
  use would leave exactly those dormant rows behind, so `runAuthSecretCheck` runs
  `reencryptToCurrentVersion` (`src/services/authSecret/reencryptServices.ts`) on every boot: each
  value not under the newest version is decrypted and written back under it, conditional on the
  value it read. A row no held version opens is left alone and logged as
  `auth.secret_unreadable_rows`. A calendar connection whose token no version opens flips to
  `NEEDS_RECONNECT` in `connectionAccessToken` rather than throwing on every sync. A new encrypted
  column joins the sweep's list, or it outlives its key. `src/tests/utils/authSecretRotation.test.ts`
  fails if a TOTP code, a backup code or a calendar token written before versioning or under
  version 1 stops working after a rotation, `src/tests/e2e/authSecretReencrypt.e2e.test.ts` if the
  sweep leaves a row on a version the next rotation drops ("keeps the AI connections signing key
  through two rotations" for `jwks`), and
  `src/services/calendarConnection/tests/connectionAccessToken.test.ts` if an unreadable token
  throws without marking the connection.
- **A session ends by deleting its row, never by flagging it; a new Better Auth secret version
  deletes every session on boot.** Push registrations (`push_registrations`, ADR 0006) hang off
  `session.id` with `ON DELETE CASCADE`, and that cascade is the only thing that stops a phone
  receiving the previous user's notices. A session marked revoked but left in place would keep its
  registration, and APNs would keep delivering to it. A rotated secret voids every cookie but
  deletes no row, so `checkAuthSecret` (`src/services/authSecret/authSecretServices.ts`), which
  `src/index.ts` awaits through `runAuthSecretCheck` before the server listens, compares an HMAC
  keyed by the secret with the one in `auth_secret_fingerprint`. A different one deletes every
  session row; none stored records the current one and deletes nothing. The raw secret is never
  stored or logged. The fingerprint is of the newest version, the one better-auth signs every
  cookie with, the phone's included; older versions only decrypt. A version rotation therefore
  still voids every cookie, and deleting the rows is deliberate, not a leftover. Moving to versions
  with the old secret as version 1 changes no fingerprint and deletes nothing. Without the check, a
  phone nobody opens after a rotation never gets the 401 that makes it unregister from APNs. A
  rolling deploy leaves a gap the check cannot close. Instances still on the old secret keep
  creating sessions after the new instance has run its check, and those rows survive it. Their cookies fail to verify on the new secret, so the phone's next call gets a
  401 and its Signed-out wipe unregisters it from APNs. The row lingers until something else ends
  it, but nothing reaches the phone. The "ends with its session" block in
  `src/tests/e2e/pushRegistration.e2e.test.ts` fails if any session end (sign-out, a sign-in on the
  same phone, a device mismatch, a password change or reset, a two-factor toggle, account deletion)
  stops deleting the row, `src/tests/e2e/authSecretCheck.e2e.test.ts` if the check stops deleting or
  starts deleting on an unchanged secret, and `src/tests/boot.test.ts` if boot stops running it or
  starts listening before it finishes.

## AI connections (`src/utils/auth.ts`, `src/utils/aiConnectionsOAuth.ts`)

The backend is the OAuth 2.1 authorization server AI apps connect through: better-auth's `mcp()`
with `cimd()` and `jwt()`. A grant acts in one organization the user picks, among those
`aiEligibility` (`src/services/aiFeatures/aiEligibility.ts`) allows: standing in it, AI connections
not Off, a Paid plan.

- **`mcp()` is registered after `twoFactor`.** Both add after hooks, and better-auth runs them in
  registration order. The provider's hook continues an OAuth flow whenever a response sets the
  session cookie and the request carried the signed query. After `twoFactor`, a password sign-in
  that ends in a challenge has already had its cookie deleted, so nothing continues until
  `/two-factor/verify-*` sets the real one. Registered first, the provider would run the
  authorization with the throwaway pre-challenge session, and a navigation request would leave with
  the next step in `Location`, which survives `twoFactor` replacing the body. "yields no code from a
  password sign-in until the challenge passes" in `src/tests/e2e/aiConnectionsOAuth.e2e.test.ts`
  fails if the order flips. Social sign-in skips the second factor here too ("Social sign-in does
  not run the second factor" above).
- **Every new authorization picks its organization.** `postLogin.shouldRedirect` sends a fresh
  authorization to the picker and clears `session.oauth_organization_id` first; only the return
  from the picker, with a choice still eligible, goes on. Otherwise a choice left on the session
  by an earlier connection, plus a consent on file for it, would issue a code for an organization
  the user never picked this time. `postLogin.consentReferenceId` checks eligibility again and
  throws when the organization stopped qualifying between picker and consent. The session field is
  `input: false`, so only the picker route, which checks eligibility, writes it.
- **Read only never grants `flexiday.write`.** A before hook on `/oauth2/consent` takes the scope out
  of whatever the consent page posted when the chosen organization is Read only, because the
  endpoint grants every requested scope when the body names none. The consent page hiding the
  option is not the control.
- **`/token` stays disabled.** `jwt()` would otherwise mint session JWTs signed by the same key as
  AI connections' access tokens.
- **Off means 404.** `/api/auth/oauth2/*`, `/api/auth/jwks`, the discovery documents and
  `/api/oauth-connect/*` answer 404 while AI connections are unavailable (`requireAiFeature`).
- **These events end OAuth grants, and only these.** A grant is the consent row plus every refresh
  and access token for the same user, client and organization (`reference_id`), and ending one
  deletes them all in one transaction (`src/services/aiConnections/grants.ts`).
  - Disconnect in Settings: that one grant (`DELETE /api/users/me/ai-connections/:grantId`).
  - Revoke on the AI usage page: that one grant, by the owner or an org admin of the grant's
    organization (`DELETE /api/organization/ai/connections/:grantId`, 404 for another
    organization's grant and while AI connections are unavailable to the organization). `src/tests/e2e/aiUsage.e2e.test.ts` checks the next MCP call fails.
  - Password reset: every grant the user holds, in `onPasswordReset`, whether or not the address
    was verified.
  - Password change with `revokeOtherSessions`: every grant the user holds, in the
    `ai-connection-grant-revocation` after hook, only once the change succeeded.
  - Account deletion: every grant the user holds, in the deletion transaction. The user row stays,
    so the `ON DELETE CASCADE` on these tables never fires and the rows go explicitly.
  - The owner turning AI connections off: every grant in the organization. Lowering to Read only:
    every grant there holding `flexiday.write`, whole; the member connects again with read access.
    Both run inside the transaction that locks the organization row and changes the setting.

  Sign-out, a password change without `revokeOtherSessions`, auth-secret rotation and turning
  two-factor on keep every grant: a grant is not a session, and those events say nothing about the
  app the member chose to trust. Refresh in better-auth checks no consent, so deleting the consent
  alone would leave the app refreshing tokens the per-call check then refuses; deleting the refresh
  tokens is what makes the next refresh answer `invalid_grant`. A reset or password change that
  stopped deleting them would leave an attacker's app connected after the victim took the account
  back. `src/tests/e2e/aiConnectionGrants.e2e.test.ts` drives each event and the next refresh, and
  fails if one stops ending its grants or a keeper starts.

## Tools and `/mcp` (`src/tools/`, `src/mcp/`)

The Assistant and the MCP server share one tool layer. A tool must see exactly what its user sees in
the app, inside one organization.

- **The tool layer imports no database module.** An ESLint `no-restricted-imports` rule on
  `src/tools/**` (the lint fence) bars `db/`, `drizzle-orm` and `pg`. Handlers call services that
  take `auth` and run their own guards, so a permission check written for the app holds for the
  tool too. `src/tools/tests/lintFence.test.ts` fails if the rule goes.
- **Every group and person a tool's input names passes the organization fence first.** A tool
  declares those fields in `fence`; `runTool` rejects any outside the context's organization with
  the same 404 as a missing one. Reads without such a field pass `organizationId` to the service.
  A user in two organizations would otherwise read the second through a grant for the first.
- **Every `/mcp` call settles the grant again.** After the JWT verifies, `loadMcpGrant` loads the
  consent for user, client and organization claim, the user, and `aiEligibility`. Disconnecting,
  leaving the organization or a lapsed plan take effect on the next call, not when the token
  expires.
- **Approve and reject never run over `/mcp`.** They carry `assistantOnly`: `toolsFor` leaves them
  out of `tools/list`, `/mcp` answers a call to them as an unknown tool, and `runTool` and
  `previewTool` refuse them on any channel but `assistant`. Deciding on someone else's request
  needs the Assistant's confirmation card; an external app has no such step.
  `mcpWriteTools.e2e.test.ts` covers all three.
- **Tool errors carry no user text or arguments.** A guard's refusal reaches the model with its
  public message and public context only; anything else is one fixed message. Invalid arguments
  name the schema's field paths, never the values.
- **No argument or result leaves the process.** The `gen_ai.execute_tool` span carries the tool,
  channel and outcome only (`src/tools/tests/toolSpan.test.ts`), `src/utils/sentryOptions.ts` sets
  `dataCollection.mcp` off, and `toToolError` logs an internal error by class name. The full list
  is under Observability below.

## The Assistant's turns (`src/services/assistant/`)

- **A turn advances in one idempotent step, keyed on session event ids.** `advanceTurn` lists the
  turn's events, records each Assistant message once (unique on chat and event id) and answers each
  waiting tool call once: the tool display row keyed on the tool-use event id is the claim, written
  before the tool runs. The relay, the webhook and opening a chat may all run it at once without a
  tool running twice. Recording or answering by anything else (the stream's arrival order, a counter)
  would run a write twice the day two of them race.
- **The webhook at `/api/webhooks/anthropic` trusts the signature alone.** It sits before the JSON
  parser and outside `authSession`, and checks the Standard Webhooks signature over the raw bytes
  with `ANTHROPIC_WEBHOOK_SECRET`. Without the secret the route answers 404, as it does while the
  Assistant is off for everyone. Each event id is stored in `assistant_webhook_events`; a failed
  advance deletes its row so Anthropic's retry runs again. `assistantWebhook.e2e.test.ts` pins it.
- **Opening a chat catches up on missed webhooks, nothing polls.** `resumeStalledTurns` advances a
  turn whose tool call has waited past `MISSED_WEBHOOK_GRACE_MS` with no relay in this process, logs
  `assistant.webhook_missed`, then follows the turn. The grace keeps a relay on another instance
  from counting as a miss, which would page someone.
- **An older build never rolls the agent back.** The agent's metadata carries
  `AGENT_CONFIG_VERSION`; a sync skips an agent stamped higher and updates with the version it read,
  so a racing writer gets a 409, which is ignored. Bump the constant with any prompt or tool change;
  `agentConfig.test.ts` pins the hash it stands for.
- **The managed driver logs failures by status and type only.** An API error message can quote a
  prompt or a tool result, so `assistant.provider_error` carries the operation, HTTP status, error
  type and class name, and the caller sees 503 `ASSISTANT_UNAVAILABLE`.
- **The screen fails closed, and a rejected message never reaches the session.** `prepareTurn`
  screens each message after claiming the turn and before creating or sending to a session. A
  failure or a timeout (`ASSISTANT_SCREEN_TIMEOUT_MS`) answers 503 `ASSISTANT_SCREEN_FAILED` with
  nothing written; an off-topic message, an attack or Haiku's own refusal is recorded as a rejected
  turn and answered with the fixed refusal. Sending first and screening beside it would let an attack
  reach the model whenever the screen is slow. `assistantScreen.e2e.test.ts` pins every path.
- **Text people wrote is screened before the model reads it.** `advanceTurn` runs the reads of one
  model response, then one screen call over every `user_text` value in their results, then answers
  them. A flagged value, or every value when the call fails, becomes
  `[withheld: looked like instructions]`. Answering a tool call before its screen would hand the
  model the very text the screen exists to stop. The screen logs (`assistant.screen_failed`,
  `assistant.tool_text_withheld`) carry ids, reasons and counts, never the text.
- **A write from the Assistant never runs before its card is confirmed.** `answerAssistantToolCall`
  only previews a write; `advanceTurn` parks it in `assistant_pending_actions` with its validated
  arguments, and only `decideCard` runs those exact arguments, with fresh guards. A refused confirm
  keeps the card open and answers nothing, so every tool call is answered once: by the confirmed
  result, "declined", or "not taken" when the user's next admitted message settles it. Card text
  comes from the stored preview, never the model, and card previews are never logged.
  `assistantCards.e2e.test.ts` pins every path.
- **A reject reason typed on the card never reaches the session.** The user writes it in the card,
  where no screen runs, so `reject_request`'s result says only `reasonGiven`. Putting the text in
  the result would hand the model unscreened input. `assistantDecisionCards.e2e.test.ts` checks it.
- **A round of tool results goes to the session whole, and only through the meter.** Answers wait in
  `assistant_held_answers` until no card of their model response is open; taking them (a delete
  that returns the rows) is the claim, so two advances can't both send them. A round the meter
  refuses keeps its answers held, and the next admitted message carries them ahead of its text.
  Answering a round's reads while its card is open, or interrupting the session, would leave a tool
  call unanswered or start a model call nobody reserved.
- **A chat never goes without its session going too.** Every path that deletes chats (own delete,
  losing the last link, End employment, Erase, account deletion, an owned organization's deletion,
  the 180-day sweep) and the day-30 close goes through `chatLifecycle.ts`, which writes the session
  id into `assistant_session_deletions` in the same transaction. The session is deleted after the
  response and on every nightly tick until the driver confirms. A raw `delete(assistantChats)`, or
  an organization delete that leans on the cascade, would leave an Anthropic session holding the
  chat for good. `assistantChatLifecycle.e2e.test.ts` checks every path.
- **Leaving is decided by the links, not by a screen.** The chat delete sits in `syncEmployment`'s
  no-link branch, ahead of the Directory early return, so every remove, revoke, group delete and
  manager change that leaves a member with no link deletes their chats there, and End employment,
  Erase and account deletion call it themselves. See [`assistant-chats.md`](assistant-chats.md).
- **A closed chat takes no message.** `prepareTurn` refuses with 409 `ASSISTANT_CHAT_CLOSED` before
  eligibility, the screen or the meter, so nothing is written, screened or charged.

## Observability (`src/utils/sentryOptions.ts`, `src/utils/tracesSampler.ts`, `src/utils/aiSignals.ts`)

Sentry is the only destination for traces, logs and metrics. The winston console and file transports
write the same entries to CloudWatch, so the rules below hold for them too.

- **Never logged, traced or counted:** chat text (the user's messages, the Assistant's answers,
  rejected messages), card previews, the system prompt and the per-user `system.message`, the
  screen's input, tool arguments and results on both channels, error messages built from any of
  these, names and email addresses, credentials (OAuth tokens and codes, PKCE verifiers, client
  secrets, the Anthropic key, the webhook secret), and Anthropic's full-content spans. Allowed: ids,
  enums and numbers. `aiTelemetryPrivacy.e2e.test.ts` drives an Assistant turn, a card and `/mcp`
  calls with marker text in each of these places and fails if any marker reaches a Sentry envelope
  or a winston entry.
- **Content capture stays off in config.** `sentryPrivacyAndSampling` sets `dataCollection.genAI`
  and `dataCollection.mcp` off, sends no request bodies, and denies the `code` and `state` query
  parameters, which carry OAuth authorization codes through redirects. The Anthropic client is
  wrapped with `recordInputs: false, recordOutputs: false`, so the screen's `gen_ai.chat` span holds
  the model and token counts only.
- **The Assistant's and `/mcp`'s signals go through `aiSignal`.** Each name lists the attributes it
  may carry and drops the rest, so a caller can't attach text by accident. `aiSignals.test.ts` pins
  the names, levels and attributes against the spec, and fails when a name has no call site.
- **An outside caller can't raise its own trace sampling.** The sampler answers `/mcp`, the
  Assistant routes, the Anthropic webhook, `/api/auth/oauth2/*` and `/.well-known/*` with their own
  rates and ignores an inbound `sentry-trace`. Inheriting there would let any client force 100%
  tracing of its traffic and spend the organization's span quota. `/api/auth/jwks` inherits on
  purpose: `/mcp` fetches it from this same server. `tracesSampler.test.ts` pins it.
- **Sentry writes the one `traceparent` on calls to Anthropic.** `propagateTraceparent` is on and
  the Anthropic SDK's own tracing and propagation are off (`anthropicClient.ts`). Two writers would
  send two headers, which Anthropic reads as an invalid trace context; none would leave Managed
  Agents' spans outside our traces.

## Local dev surface (`src/routes/devRouter.ts`, `src/middleware/devGuard.ts`, `src/services/dev/`)

`/api/dev/*` seeds verified users, teams, quotas and vacations, and issues session cookies, so the
frontend can be driven locally without SES email verification. It is gated five ways and must stay
that way:

1. `server.ts` only mounts the router when `config.dev` is defined.
2. `parseDevTools()` in `config.ts` returns `undefined` unless `DEV_TOOLS_ENABLED=true`, and
   **throws at startup** if that is combined with `NODE_ENV=production`.
3. It also throws if `DATABASE` does not point at localhost.
4. `devGuard` requires a loopback `socket.remoteAddress` — deliberately not `req.ip`, which follows
   the spoofable `X-Forwarded-For` because `trust proxy` is on.
5. `devGuard` requires `x-dev-token` to match `DEV_TOOLS_TOKEN` (timing-safe, ≥16 chars).

Seeding is confined to `DEV_SEED_EMAIL_DOMAIN` (default `dev.local`), which is also the exact scope
of `POST /api/dev/reset` — there is no unscoped delete. Users are created by inserting `user` +
`account` rows with better-auth's own `hashPassword`, bypassing `signUpEmail` because that runs the
haveIBeenPwned check (an outbound call that fails offline) and fires a verification email. A
seeded user's id comes from better-auth's `generateId()`, the generator real sign-ups use, and is
never a UUID: a UUID there would let a UUID validator on a user id pass every local check in the
browser or on the simulator and fail in production. `src/services/dev/tests/devSeedServices.test.ts`
pins the shape.

`POST /api/dev/calendar/connect` fabricates a calendar connection with no consent round, so it
refuses (409) unless `CALENDAR_SYNC_DRIVER=fake`, which boot refuses in production. A fabricated
connection holds fake tokens and can only ever reach the fake driver, never a real Google or
Microsoft calendar. `src/tests/e2e/devCalendar.e2e.test.ts` ("refuses to fabricate a connection
unless the driver is fake") fails if the check goes.
[`calendar-direct-sync.md`](calendar-direct-sync.md#local-development) has the three calendar
routes.

The frontend half is gated too: `/dev-sign-in/` only builds when `NEXT_PUBLIC_DEV_TOOLS=1`, and
`pageExtensions` in `next.config.ts` keeps `page.dev.tsx` files out of production output entirely.

### Dev sign-in ticket (`src/services/dev/signInTicketServices.ts`, `src/utils/devSignInTicket.ts`)

The phone app signs in locally with a ticket instead of a password. `POST /api/dev/sign-in-ticket`
mints one for any user in the local database: a random 256-bit string, bound to that user,
redeemable once, dead after 60 seconds, held only in the backend's memory. A restart voids every
outstanding ticket, which costs nothing at that lifetime. The phone redeems it at
`POST /api/auth/dev/redeem-sign-in-ticket`.

- **Mint keeps all five gates.** It is an ordinary `/api/dev` route behind `devGuard`.
- **Redeem keeps gates 1–3 and skips 4–5.** It is a better-auth plugin endpoint, added to
  `betterAuth({ plugins })` only when `config.dev` is defined, so it does not exist in production or
  against a remote database. It does not sit behind `devGuard`, and that is deliberate: the
  simulator's app reaches the backend over the Mac's LAN address, which is not a loopback peer, and
  the app must never hold `DEV_TOOLS_TOKEN`, because a Release build made from the same checkout
  would ship it. The ticket is the credential in their place: single-use and short-lived, so one
  seen on the LAN is worth nothing once redeemed or a minute old. Do not put redeem behind
  `devGuard`, which breaks it on the phone, and do not relax its `config.dev` gate or lengthen the
  ticket's life, which turns it into a sign-in anyone on the network can replay.
- **Redeem refuses a request without a valid `x-client-device-id`** (400 `DEVICE_ID_REQUIRED`), so
  every session it opens is device-bound. An unknown, spent or expired ticket gets one answer, 401
  `INVALID_SIGN_IN_TICKET`, that does not say which.
- **Redeem creates the session through better-auth** (`internalAdapter.createSession` and
  `setSessionCookie`), never by inserting a row. That is what lets the path-agnostic hooks from
  "A native session only answers to the device that opened it" and "One phone holds one session"
  stamp the device id and ten-year expiry, evict the phone's previous session and re-issue the
  cookie without `Max-Age`. It carries no binding logic of its own, so a change to those hooks
  shows up here. `src/tests/e2e/devSignInTicket.e2e.test.ts` pins the result against a native
  password sign-in, and `src/tests/config.devSignInTicket.test.ts` pins the endpoint's absence
  with dev tools off.

## Platform-support surface (`src/routes/supportRouter.ts`, `src/middleware/supportGuard.ts`, `src/services/support/`)

`/api/support/*` lets the platform owner inspect any organization or group (cross-tenant,
read-only) to debug customer reports.

1. **The allowlist is an env var, not a DB flag.** `SUPPORT_ADMIN_USER_IDS` (comma-separated user
   ids) parses into `config.support`; unset means the router is never mounted. No API can grant the
   role, so there is no privilege-escalation surface — it changes only via deploy. Malformed
   entries throw at boot (an allowlist that silently never matches is worse than a crash).
2. **Dedicated read-only endpoints, not a bypass.** The support reads live in `supportServices.ts`
   and take their scope as explicit ids. Keep support carve-outs out of `assertGroupAdmin` /
   `validateUserGroupAccess` / `isOrganizationAdmin` — one there would silently turn every route,
   including writes, into a superuser route.
3. **`requireSupportAdmin` answers three ways.** 401 when `req.auth` is absent, **404 for an
   authenticated caller not in `config.support.userIds`** (not 403 — the surface should be
   invisible to probers), and **403 for an allowlisted account without 2FA enabled**. The 2FA
   check is on the account, not the session, so a password alone never opens this surface. It
   reads `req.auth` directly rather than importing `authSession.js`, keeping better-auth out of
   its import graph.
4. **Every request is audited.** The guard writes a `support_access` row (user, method,
   path+query) before the handler runs. Write-only, like `report_exports`.
5. **The frontend learns about the role from the session.** The `customSession` plugin in
   `auth.ts` adds `supportAdmin` to the get-session payload, so normal users never probe a support
   endpoint (no 404 noise, no failure-limiter burn, nothing in their network tab). The flag is a
   UI hint only; the guard re-checks the allowlist on every request.
6. **Responses exclude `note` and `rejectionReason`** from vacation rows — personal detail that
   debugging state bugs never needs.
7. **The directory shows as state and counts, never a Profile field.** The organization detail
   carries `directory` from `directorySupportSummary`: on or off, agreement versions and counts.
   Flexi Day processes directory data for the organization, so support has no reason to read it.
   "support detail shows the directory without a Profile field" in
   `directorySettings.e2e.test.ts` pins the shape.

## Rate limiting (`src/middleware/limiter.ts`)

Several limiters, not one, because a single per-IP bucket both throttles real users and
under-protects the endpoints that matter:

| Limiter                      | Mounted on                                                                       | Key                            | Budget                                      |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------- |
| `floodLimiter`               | everything                                                                       | IP                             | 5000 / 5 min                                |
| `apiFailureLimiter`          | `/api` (before session validation), unvalidated requests only                    | IP                             | 100 **failures** / 5 min                    |
| `apiLimiter`                 | `/api` (after the auth and dev routes)                                           | validated user id, IP fallback | 1000 / 5 min                                |
| `credentialsLimiter`         | sign-in / sign-up / reset-password / two-factor / invite link / account deletion | IP                             | 20 **failures** / 15 min                    |
| `passwordResetLimiter`       | `request-password-reset`                                                         | IP                             | 5 / 15 min                                  |
| `otpSendLimiter`             | `two-factor/send-otp`                                                            | challenge cookie, IP fallback  | 10 / 15 min                                 |
| `calendarFeedLimiter`        | `/calendars/:token.ics`                                                          | feed token                     | 120 / hour                                  |
| `signedWebhookLimiter`       | `/api/webhooks/paddle`, `/api/webhooks/anthropic`, `/api/attachments/processed`  | IP                             | 5000 / 5 min                                |
| `mcpUnauthBudget`            | `/mcp`, answers of 401 or 403 only                                               | IP                             | 2000 **failures** / 5 min                   |
| `mcpCallBudget`              | `/mcp` `tools/call`                                                              | user id + OAuth client id      | 300 / 5 min                                 |
| `mcpWriteBudget`             | `/mcp` `tools/call` of a write tool                                              | user id + OAuth client id      | 30 / hour                                   |
| daily AI connection limit    | `/mcp` `tools/call`, Postgres `ai_connection_daily_calls`                        | organization, UTC day          | Pro 5000, Enterprise and Custom 20000 / day |
| member daily limit           | `/mcp` `tools/call`, Postgres `ai_connection_member_daily_calls`                 | organization + user, UTC day   | 1000 / day                                  |
| better-auth `token` rule     | `/api/auth/oauth2/token`                                                         | IP (better-auth's own)         | 600 / min                                   |
| better-auth `authorize` rule | `/api/auth/oauth2/authorize`                                                     | IP (better-auth's own)         | 30 / min                                    |
| better-auth `register` rule  | `/api/auth/oauth2/register`                                                      | IP (better-auth's own)         | 5 / min                                     |
| `dcrDailyLimiter`            | `/api/auth/oauth2/register`                                                      | one global key                 | 1000 **registrations** / day                |

- **`apiLimiter` keys on the session, not the IP.** Keying on the IP pools every user behind one
  office NAT, VPN or mobile CGNAT into a single allowance. Custom key generators must run IPs
  through `ipKeyGenerator` — a bare `req.ip` lets one IPv6 /64 rotate addresses freely.
- **`apiFailureLimiter` counts only failures from requests without a validated session.** Its
  success rule treats any request that carries `req.auth` as a success, whatever its status, so
  the routine 403, 404 and 409 answers a signed-in user gets never pool an office IP into a
  lockout. Signed-in traffic is bounded by `apiLimiter` alone. What still counts: no cookie, an
  invented cookie, an expired or device-mismatched session, and a session lookup that errors. The
  rule reads `req.auth` when the response finishes, so the limiter can stay mounted before
  `authSession`.
- **`credentialsLimiter` covers the whole `/api/auth/two-factor` surface, not just the verify
  endpoints.** A 6-digit code is far cheaper to guess than a password, and enable / disable /
  get-totp-uri / generate-backup-codes are password oracles — without the failures-only budget, a
  stolen session cookie could brute-force the password via `POST /two-factor/disable` and switch
  2FA off. `otpSendLimiter` exists for `send-otp` for the same reason `passwordResetLimiter` does:
  the route always answers 200, so failures-only counting never triggers, and what needs bounding
  is the email it sends. It keys on the challenge cookie rather than the IP, so an office NAT
  never pools — and the phone needs nothing of its own for that, because the expo client forwards
  its cookie jar as a `Cookie` header exactly as a browser does
  (`src/tests/e2e/nativeSession.e2e.test.ts`, "keys a native request on the cookie it carries").
- **`credentialsLimiter` covers `POST /api/users/me/delete`.** It checks the current password
  behind a session, the same kind of oracle as `/two-factor/disable`, and lives in our own users
  router, where neither better-auth's limiter nor a per-IP failure budget sees a signed-in request.
  Without this entry the only bound would be `apiLimiter`'s 1000 requests per user. Every 4xx it
  answers counts, as on the invite endpoints; a 204 does not. Prefix matching is per segment, so
  `GET /api/users/me/deletion` stays outside.
- **`passwordResetLimiter` exists because `credentialsLimiter` cannot cover that route.** Asking
  for a reset answers 200 for every input on purpose (it must reveal nothing about which addresses
  exist), and `credentialsLimiter` counts only failures — so nothing would ever increment. What
  needs bounding there is the email it sends, not guessing. It keys on the IP, so it bounds volume
  per source and **not** per address; a distributed flood at one address is still open.
- **The invite link endpoints ride `credentialsLimiter`.** `/api/auth/invite/*` is our own router,
  not better-auth's, so better-auth's 50/10s rule never sees it. The failures-only budget is what
  bounds a prober: an unknown secret answers 404, and a real one is 256 bits. Sign-up with invite
  calls better-auth's sign-up and sign-in through `auth.api`, which skips better-auth's limiter too,
  so this budget is the only one on it.
- **`credentialsLimiter` sets `skipSuccessfulRequests`.** Only failures count, so a whole team
  signing in at 9am is unaffected while a password guesser burns the budget.
- **`calendarFeedLimiter` keys on the token.** Google polls every subscribed feed from a handful of
  shared ranges, so an IP key would throttle all users at once.
- **`floodLimiter` skips `OPTIONS`, `/health` and `/mcp`.** Preflights are not attack surface (CORS
  `maxAge` caches them) and the health check must not spend a caller's budget. `/mcp` is skipped
  because Anthropic makes every Claude connector call from a few fixed egress addresses, so a
  per-IP flood bucket there would be shared by every Claude user at once. The limits below bound
  `/mcp` instead. `src/tests/middleware/limiter.test.ts` covers all three skips.
- **`mcpUnauthBudget` counts only requests that fail authentication, and refuses only those.**
  `/mcp` sits outside `/api`, so neither `apiFailureLimiter` nor `apiLimiter` sees it; discovery
  401s and expired tokens are routine there and would trip `apiFailureLimiter` within minutes on
  Anthropic's shared addresses. Once an address has 2000 failed answers in 5 minutes, a request
  with no token gets 429 before any work, and one whose token fails gets 429 instead of 401. A
  token that verifies is never refused by it, so one misbehaving client behind a shared address
  can't lock out everyone else there. JWT verification is a local signature check, which is why a
  flood of junk tokens is cheap enough to verify before counting. Code in `src/mcp/mcpHttp.ts`.
- **The MCP burst budgets key on user and OAuth client together.** A user with two apps gets two
  budgets, and two users of one app never share one. 300 calls in 5 minutes is far above what a
  person's conversation produces and stops a looping agent; 30 write calls an hour bounds the
  emails a write sends (a created request mails its approvers, a cancel sends notices). Both are
  in memory: two instances double them, which is accepted.
- **The daily limits live in Postgres, and only `tools/call` counts.** They must hold across
  deploys and instances, unlike the burst budgets. Each call upserts the organization's row and
  the member's row for the UTC day (`date_trunc` on the database clock, so no reset job runs); a
  row only rises while under its limit, so concurrent calls can't pass it, and a refused call
  counts on neither row. `initialize`, `tools/list`, resources and pings don't count, and neither
  does the Assistant, which runs tools in-process under its own Weekly limit. The member daily
  limit exists so one looping agent can't use the whole organization's day. The first refusal of
  a day stamps `limit_reached_at` and logs `mcp.daily_limit_reached`, once per organization and
  day.
- **Burst and daily limits answer as tool results; transport limits as 429.** A refused
  `tools/call` is a normal `isError` result naming the limit and its reset in the user's app
  language (`src/mcp/mcpLimits.ts`), because an AI app shows a bare 429 as "connection failed" or
  retries blindly, while a tool result reaches the model, which can tell the user.
  `mcpUnauthBudget`, the OAuth endpoints and `dcrDailyLimiter` answer 429 with `Retry-After`.
- **The OAuth provider's limits are better-auth's, raised where Anthropic's egress shares them.**
  Set through `mcp({ rateLimit })` in `src/utils/auth.ts` and off under vitest like the rest of
  better-auth's limiter (`src/tests/e2e/oauthLimits.e2e.test.ts` turns it on per test). The token
  endpoint goes from the default 20 to 600 a minute: every Claude user's code exchange and refresh
  comes from Anthropic's addresses, and codes and refresh tokens are long, random and bound to
  PKCE, so the limit only bounds floods. `authorize` stays at 30, a browser redirect from the
  user's own address. better-auth answers its 429 with `X-Retry-After` only; `mirrorRetryAfter`
  copies it to `Retry-After`.
- **Dynamic Client Registration stays open, with three bounds.** Cursor, VS Code and other clients
  without a pre-registered id need it. better-auth's per-address 5 a minute (these clients
  register from the user's machine), `dcrDailyLimiter`'s 1000 successful registrations a day
  across every address, and each registration deleting the clients older than 7 days that hold no
  grant (no consent, refresh or access token; `pruneUnusedOAuthClients`). Clients found through a
  metadata document are left alone. The pruning runs in the request, so no sweep job exists.

The store is in-memory, except for the two daily limits, which are Postgres rows: counters are
per-process and reset on deploy. Running more than one instance multiplies the effective limits, so
scaling out needs a shared store first.

## Sync pull transport (`src/routes/syncRouter.ts`)

`GET /api/sync/pull` is the phone app's whole view of the backend, so its transport is part of the
contract rather than a tuning detail. See [`sync-pull.md`](sync-pull.md) for what it answers.

- **It is the only compressed surface.** `compression` is mounted on the sync router alone, not in
  `server.ts`, and with `threshold: 0` so a small delta is encoded like a large snapshot. Moving it
  up to the app would start compressing every other API response, which is a decision nothing has
  taken: `src/tests/e2e/syncPullTransport.e2e.test.ts` asserts an over-threshold body on another
  `/api` route still comes back uncompressed.
- **It adds no limiter of its own.** The router is mounted under `/api`, so it sits behind
  `apiFailureLimiter`, `authSession` and `apiLimiter` like every other API route, and a pull spends
  the same per-session budget a web request does. The e2e suite pins that from outside: a pull
  carries the same rate-limit header names, limit and policy as `/api/group`. A sync-specific
  limiter would let a phone loop past the budget the rest of the API holds a user to.
- **Every response is `no-store`.** The envelope is selected by the caller's user id, so no cache
  may hold it, and the header survives compression.

## Organization admin boundary (`organization_users`)

See [`../GLOSSARY.md`](../GLOSSARY.md) for what an org admin _is_. The boundaries:

- **Owner-or-row.** The owner holds no `organization_users` row; `organizations.ownerUserId` is
  the other half of the answer. Querying the table alone answers half the question — always go
  through `isOrganizationAdmin`, and for group standing through the `groupUser/groupAccess.ts`
  resolvers, which credit the manager as well as the membership row.
- **Administration, never approval.** `assertGroupAdmin` / `validateUserGroupAccess` accept org
  admins; `getGroupsWhereUserCanApprove` does not, and two routes actively defend the boundary:
  `handleUpdateGroupUsers` refuses to let any caller raise their **own** permissions (checking
  every record for them, not just the first — the array may repeat a user), and
  `handlePutGroupApprovers` refuses a caller acting `viaOrgAdmin` who names themselves. Without
  both, a delegate could invite themselves in and self-promote to approver. Change manager
  (`handlePutGroupManager`) is open to org admins only, and a manager approves, so it refuses a
  caller who names themselves (403 `CANNOT_NAME_SELF`). Naming another live member is allowed on
  purpose: it is how an organization hands on a group whose manager left, and the change log
  records who did it. "refuses an org admin who names themselves" in
  `deletedManager.e2e.test.ts` fails if the refusal goes. The group's manager sits outside this
  boundary on purpose: they administer their group in their own right (`viaOrgAdmin: false`) and `getGroupsWhereUserCanApprove` already accepts them, so a manager
  naming themselves approver is allowed — creation even defaults them to main approver. The
  membership requirement still applies: a manager without a `group_users` row hits the same
  "approver must be a member" 422 as anyone else.

  **One deliberate carve-out — records on behalf of members.** Managing a member's booking is
  administration, so org admins (like group admins) may create a booking for a member via
  `POST /create-vacation` with `userId` — including `autoApprove`, which stamps them as
  `approvedBy` — edit its per-day fields via `PATCH /api/vacation`, and cancel it
  (`resolveVacationPermissions` and the cancel transitions in `vacationTransitions.ts` resolve
  admin standing through `resolveGroupAdmin`). Every such write is attributed (`createdByUserId` / `deletedByUserId`,
  CREATED/APPROVED/UPDATED/CANCELLED timeline events). The boundary itself stands: deciding a
  **member-submitted** request stays approver-only (`getGroupsWhereUserCanApprove` still excludes
  org admins, `autoApprove` is refused for self-bookings), and both defenses above remain.

- **Scoped to one organization.** `getAdministrableGroupIds` takes an `organizationId`; mirroring
  passes it, or someone who owns org A and is a delegate in org B could project B's leave into A.
- **Reading a group by id opens administered groups; everything aggregated stays membership-only.**
  `getReportScopeEntries` adds every group the caller administers to their memberships, across all
  their organizations. It gates the report and each read that names one group: the list and calendar
  (`GET /api/vacation?groupId=`, `/api/vacation/calendar`), `GET /api/birthdays?groupId=` and the
  `dashboardGroupId` check in my-settings. Those are the groups `/api/reports/scope` offers the web's
  pickers, so the two can't disagree. `getScopeEntries` stays membership-only for the reads that
  gather across groups without being asked for one: the sync pull, team calendar feeds, the
  dashboard summary and birthday sharing (`visibleBirthdays`, `sharedBirthdaysInGroups`). Widening
  it would put every group an org admin administers on their phone, in their feed and in their
  summary counts, and show them birthdays members shared with teammates. Reading never grants
  deciding: `canApprove` and the decision endpoints stay on `getGroupsWhereUserCanApprove`, so an org
  admin sees pending requests in an administered group with `canApprove: false`.
  `adminGroupScope.e2e.test.ts` and the "outside the report" cases in
  `reportAdministeredScope.e2e.test.ts` fail if either side moves.
- **The grant is scoped to membership.** `handleDeleteGroupUser` revokes it when the user leaves
  the organization's last group, under a `lockOrganization` — the count spans the org, so a group
  lock alone lets two concurrent removals each see the other's membership as live. A Directory
  organization is the exception: the person stays employed in no group and keeps the grant until
  End employment drops it ("removing the last group ... keeps the admin grant" in
  `directoryEnding.e2e.test.ts`).
- **Every path that grants or revokes a grant takes `lockOrganization`.** `grantOrganizationAdmin`
  and `handleDeleteGroupUser` always did; `handleDeleteOrganizationAdmin` now does too. Revoking
  and losing the last membership are the two removals that can end an Employment, and
  `handleDeleteGroupUser` does both in one transaction. Unserialized, the two can interleave so
  each sees the other's link as still live, the membership transaction then finds the grant
  already gone and skips its own recomputation, and the Employment is left open with nothing
  holding it.
- **A billing write never reaches the organization the caller merely administers.** `billingEmail`,
  granting and revoking admins all go through `assertOrganizationOwner`. Change-plan, slots and the
  portal resolve the org with `getOrganizationForOwner`, which finds nothing for a delegate.
  Checkout is the one that does not refuse them — `ensureOrganizationForUser` gives every caller an
  organization they **own**, creating it if needed, and that id is what rides in Paddle's
  `customData`. So a delegate who checks out buys a plan for an organization of their own, never
  for the one they administer. Resolving checkout against the administered org would be the
  escalation; refusing delegates outright would only stop someone starting their own paid org.
  Only the read widened: `GET /api/billing/subscription` resolves the organization the caller
  _administers_ (`getAdminOrganizationsForUser`, owned first), because a delegate shown Free was
  locked out of every paid feature they administer. The client is told which case it is by
  `organization.isOwner`, so it stops offering a delegate a "Subscribe" that would quietly put a
  plan on a new organization of theirs.
- **Delegates are picked from the organization's own people.** `listOrganizationAdminCandidates`
  is deliberately not a lookup by email, which would let an owner probe whether an address has an
  account.

## Private details and Away (`src/services/vacation/redaction.ts`)

See [`../GLOSSARY.md`](../GLOSSARY.md) for **Private details** and **Away**. The rule:

- **Privileged readers.** The owner of a vacation row, and the approvers and group admins of the
  row's own group (`getGroupsWhereUserCanApprove`, `resolveGroupAdmin`, so an org admin of the
  owning organization counts, member or not). `resolveVacationViewer` in
  `vacationPermissions.ts` answers it for a batch, as the viewer `viewVacationRowAs` takes; `canReadPrivateDetails` on
  `VacationPermissions` answers it for one row.
- **Everyone else who can see the row is a teammate**, and `viewVacationRowAs` gives them:
  - `vacationType: "AWAY"` in place of `SICK`. Every other type, `SICK_DAY` included, is unchanged.
  - `note`, `rejectionReason`, `rejectedBy`, `rejectedByUser`, `deletedByUserId` and
    `deletedByUser` as null. The detail endpoint sends `history: []` and no attachment fields.
  - nothing at all for another person's rejected or cancelled row: the list and calendar leave it
    out, and the detail endpoint answers it with the same 403 as a row the caller may not view.
- **The record's own group, never the mirror.** Standing is read against `row.groupId`. A row
  mirrored into a group keeps its source group's `groupId`, so the target group's approvers and
  admins get the teammate view of it. Keying on the group being listed would hand them the full row.
- **The detail endpoint's visibility follows the list's, mirrors included.** `canView` in
  `resolveVacationPermissions` also holds when a live mirror projects the row into a group the
  caller sees in full: `getProjectingMirrorTargetGroupIds` uses the `liveMirror` predicate
  `getVacationsForGroup` and the sync pull use, and the scope check is the
  `getReportScopeEntries` + `canViewWholeGroup` pair `listVacationsInScope` uses. Only sight
  widens; every other flag stays keyed on `row.groupId`, so such a caller gets the teammate view
  with no actions. A separate rule for either side would let the list show a record whose detail
  answers 403, or the detail open one the list hides. `mirroredDetail.e2e.test.ts` fails if they
  disagree or if a mirror reader gets a private field.
- **`AWAY` is wire-only.** It lives in the response types (`WireRecordType`) and the `@openapi`
  response enums. It is not in the `vacation_type` PG enum, `CalendarRecordType`,
  `requestableRecordTypeEnum` or any write validator, so no write can store it. Accepting it on a
  write would store a type no quota, report or attendance rule knows.
- **Commenting follows reading.** `mayComment` in `vacationTransitions.ts` checks
  `canReadPrivateDetails`, not `canView`: a comment lands on the timeline only privileged readers
  see. Checking `canView` again would let any View member write onto a teammate's timeline and
  notify the owner from it. The detail response carries `canReadPrivateDetails` so a client knows
  whether to offer the comment box.
- **Every read of another person's row goes through `viewVacationRowAs`.** Today that is
  `GET /api/vacation/:id`, `GET /api/vacation?groupId=`, `GET /api/vacation/calendar` and
  `GET /api/sync/pull`.
  `privateDetails.e2e.test.ts` fails if any of them hands a teammate Sick or a private field.
- **A team calendar feed has no privileged readers.** `vacationRecords` in
  `calendarSyncServices.ts` reads every row through `viewVacationRowAs` with `teammateViewer`, a
  viewer holding no privileged groups, so even an approver's or admin's team feed shows other
  people's Sick as Away (`Pryč`) and carries no note of theirs. The feed URL is a bearer link: the
  owner's rights would reach whoever holds it. The owner's own rows stay complete, and a Me feed
  holds only those. The feed filters on the stored type, so the config's `SICK` toggle decides
  whether teammates' Away events appear; Away is never a configurable feed type.
  `calendarFeedPrivateDetails.e2e.test.ts` fails if a team feed hands out a teammate's Sick or note.
- **The sync pull reads as the caller.** `readVacationsPage` in `syncServices.ts` resolves the
  caller's viewer once per pull, over the groups seen in full and the sources mirrored into them,
  and reads every row through `viewVacationRowAs`. A teammate's Sick goes out as `AWAY` only to a
  pull sending `x-client-sync-accepts: away`, and is left out of any other, because an older phone
  build fails a whole page on a type it does not store. A teammate's rejected or cancelled row is
  absent from a snapshot and a content-nulled tombstone in a delta. Every exclusion sits in the
  query's `WHERE`: the page walk reads a short page as the end of the table, so a row filtered out
  after the read silently ends it. `getVacationActorIds` follows the same view, so no teammate's
  rejecter or canceller is named. A change to the caller's standing, org admin or a mirrored source
  group's approvers included, is a sync reset trigger, so the next pull replaces what the phone
  held. [`sync-pull.md`](sync-pull.md#private-details) has the contract;
  `syncPullPrivateDetails.e2e.test.ts` fails if a pull hands a teammate Sick, a private field or a
  declined row.
- **Reports and the export go through `viewReportRowAs` instead.** It applies the same privileged
  reader rule but leaves a teammate's Sick out rather than showing Away, because Away means nothing
  as a usage line. `getBookingsForScope`, `aggregateUsageByUserMonth` and `aggregateUsageSplit`
  take a `VacationViewer`, not a caller id, so none of them can skip it. Bookings pass through it
  before `collapseBookings`, so a teammate's run is built only from days the viewer may see, and
  the export's `rowCount` counts what is exported. A mixed export is decided per row by
  the row's own group; the Note column stays and is blank on a teammate's rows.
  `reportPrivateDetails.e2e.test.ts` fails if the overview, member report or either sheet hands a
  teammate Sick, a note or a rejected row.
- **Team attendance labels absences as the caller.** `getAttendanceExclusionsForPeople` reads a
  person's approved absences from every group of the organization and resolves the caller's viewer
  over those absences' own groups, so a group admin who sees the person through one group gets
  `AWAY` for a `SICK` booked in another. The excluded day itself stays, because the balance
  depends on it. Only the type leaves, so it goes through `viewRecordTypeAs` rather than
  `viewVacationRowAs`. The builder takes the caller's id, not a `VacationViewer`, because the
  groups to resolve are known only once the absences are read. `attendanceSickRedaction.e2e.test.ts` fails if `GET /api/attendance/team` hands
  an admin of another group the real `SICK`.
- **`/api/reports/scope` years are not redacted.** A year holding only a teammate's Sick or
  rejected row still appears in `years`; it says the year has data, never what.

## Employment roster (`employments`, `src/services/employment/`)

- **The roster is written by the link, never by a screen.** `syncEmployment` hangs off the service
  functions that change the four links of ADR 0004 — `ensureOrganizationForUser`,
  `grantOrganizationAdmin`, `removeOrganizationAdmin`, `createGroup`, `updateGroupManager`,
  `deleteGroup`, `createGroupUser`, `deleteGroupUser` — not off the controllers that call them. A
  new join path therefore keeps the roster in step without knowing the roster exists, which is the
  whole risk the ADR names. End employment (`employment/endEmploymentServices.ts`) is the one act
  that ends a row directly: it removes every link itself and then stamps the chosen date, which a
  `syncEmployment` would overwrite with `now()`. In a Directory organization `syncEmployment` only
  opens, whatever the plan, so End employment is the only way a spell ends there.
- **It recomputes, never applies a delta.** `syncEmployment` asks `hasOrganizationLink` what is
  left and writes the answer, so two link removals in one request end the Employment exactly once
  whichever order they land in — `handleDeleteGroupUser` drops the last membership and revokes the
  admin grant, and only the second of those finds nothing left. A delta would double-end it or
  miss it depending on the order.
- **It runs in the caller's transaction.** The row that decides the answer is usually one the
  caller has just written and not committed; passing `tx` is what lets the sync see it. A caller
  with no transaction of its own gets one: `ensureOrganizationForUser` opens it, because an
  organization and its owner's Employment are a single fact and checkout creates one outside any
  boundary.
- **Reading an Employment is wider than belonging to one.** For attendance, `attendanceAccess.ts`
  is the only statement of who may read and correct one, and it deliberately leaves the Employment
  of anybody who belongs to no group to org admins alone, because a group admin's scope reaches
  only people who hold a `group_users` row. Who reads an Employment's Profile is the Permission
  table's business instead (`permissionResolver.ts`, see [`directory.md`](directory.md)), and the
  two never stand in for each other.
- **A group's manager is not one of its members for attendance.** Creating a group gives the
  manager a full `group_users` row, so `administersGroupOfMember` and `getMemberIdsExcludingManagers`
  skip a row whose user manages that row's group, as the visibility table in
  [`attendance.md`](attendance.md#visibility) requires. The rule is per group: a manager who is a plain
  member of another group stays in that group's scope. Vacation credits the manager's own row on
  purpose and does not go through these helpers. `attendanceManagerScope.e2e.test.ts` fails if a
  group admin sees or corrects their own group's manager.

## Quota allocation (`src/services/userYearQuotas/yearAllocation.ts`)

- **A missing quota row means the group defaults, with nothing carried over, for every caller.**
  The booking guard, `GET /api/users/me/balances`, the report summary (overview, member detail and
  the export's summary sheet) and the carry-over suggestion all take a member's allocation from
  `resolveYearAllocation`, and the metered allowance per type from `allowanceFor`, which also
  leaves Sick day unmetered where the organization's benefit is off. A reader with its own fallback
  would show `allocated: 0` and a negative remaining for days the guard allowed.
  `src/tests/e2e/missingQuotaAllocation.e2e.test.ts` books up to the default and checks that every
  reader then shows zero remaining. `computeRolloverRow` opens the new year's rows through the
  same `resolveYearAllocation`. The iPhone app's local balance has to match the rule too.
- **The guard reads the allocation after taking its locks.** `assertGrouped` takes every bucket's
  advisory lock, in key order, before it reads any allocation or total, so a booking that waited on
  the lock sees what the competing one committed.

## Account deletion (`src/services/accountDeletion/`)

The policy is in [`account-deletion.md`](account-deletion.md). Two things it leans on elsewhere:

- **`changes.changing_user_id` keeps no `ON DELETE`.** A NULL actor with `changing_user_deleted`
  false is how the quota rollover is told apart from a person. Account deletion now keeps the
  user row and the actor id; the flag stays only on rows from deletions made before that, and a
  check constraint stops it riding with an actor id. Switching the FK to `SET NULL` would relabel
  every deleted admin's edits as the rollover's.
- **A Deleted account never gets a session.** The `databaseHooks.session.create.before` hook in
  `src/utils/auth.ts` refuses any session for a user row with `deleted_at`, whatever let the
  sign-in get that far. Without it a credential or provider link written back onto the stripped
  row would sign someone in as the organization's frozen record.
  `src/tests/e2e/deletedAccount.e2e.test.ts` ("keeps only the id, and nobody can sign in as it")
  plants both and fails if the sign-in succeeds.
- **The Employment is stamped before the user row is stripped.** The `employments_follow_user`
  trigger copies `user.name` and `user.email` onto open Employments, and since migration 0033 it
  skips those with `account_deleted_at`. Stripping first would blank the organization's copy.
- **Every path that adds an account to an organization takes `lockOrganization`.** Deletion locks
  the organizations the user owns or manages a group in, then checks its blockers again. A join
  that skipped the lock could commit between that check and the delete, and the other person's
  group or organization would go with the account. Adding a person without an account
  (`createDirectoryPerson`) skips it on purpose: the record names no user, so no deletion blocker
  can depend on it, and the Claim that later binds an account runs inside a join path that holds
  the lock. `src/tests/e2e/accountDeletion.e2e.test.ts` covers the
  blockers and the all-or-nothing rollback.

## Calendar direct sync (`src/services/calendarConnection/`)

- **A calendar connection is never a sign-in link.** Connecting Google or Microsoft for direct
  sync runs its own consent round (the calendar scope alone, with `prompt=consent` on Google,
  which returns a refresh token only on consent) and stores its own refresh token, encrypted, in
  a `calendar_connection` row, even when the user signs in with the same account. Sync code
  reads tokens only from that row, and `disconnectProvider` deletes only that row and the
  targets' ledgers; it never reads or writes `account`. Mixing the two would let disconnecting
  the calendar sign the user out of their provider, or let a sign-in token, which carries no
  calendar scope, stand in for a grant the user never gave.
  `src/tests/e2e/calendarDirectSync.e2e.test.ts` ("disconnects Google, purging its targets and
  leaving the sign-in account untouched") fails if a disconnect touches the user's `account` rows.
- **The calendar callback authenticates by state alone.**
  `GET /api/calendar-sync/connections/:provider/callback` is mounted ahead of `authSession`,
  because the browser arrives from the provider's domain and a session cookie cannot be relied on
  to survive that redirect. Its credential is the `state` that `startConnection` signs: an HMAC
  SHA-256 over the user, config, time zone, provider, a nonce and a ten-minute expiry, keyed with
  the better-auth secret and compared in constant time (`oauthState.ts`). Nothing is exchanged or
  written until the state verifies for that provider and its user still owns the `ME` config.
  The trade-off of a stateless state is that it is not single-use: within its ten minutes, anyone
  holding a user's consent URL could finish that user's connection with their own account, which
  the provider's consent screen makes visible to whoever completes it. Every outcome is a redirect
  to the web with a fixed code, never a token or the provider's own error text.
  `src/services/calendarConnection/tests/oauthState.test.ts` fails if an expired, rewritten,
  wrongly keyed or other-provider state verifies, and
  `src/services/calendarConnection/tests/completeConnection.test.ts` fails if a rejected state or
  a config its user does not own reaches the code exchange or any write.

- **Direct sync writes only the owner's records and the events of the groups the owner is a live
  member of; never another member's birthday.** A sync target writes into one person's own
  calendar, so it may carry nothing but that person's approved records, their own birthday and the
  group events of the groups they are in now, never a teammate's absence and never another
  member's birthday, shared or not. The check
  constraint `calendar_sync_target_me_scope_chk` (`connection_id IS NULL OR scope = 'ME'`)
  keeps a connection off any `TEAM` config, whatever path writes the row, and
  `assertTargetAttachable` and `attachTarget` refuse one with 400 `CALENDAR_SYNC_TEAM_SCOPE` before
  the database has to; `updateCalendarSync` refuses to turn a connected config `TEAM`.
  `markCalendarTargetsDirty` marks due only `scope = ME` targets owned by the changed row's user.
  `markBirthdayTargetsDirty` marks only the targets of the user whose birthday changed. The engine
  builds its desired set from `getFeedRecords` on that `ME` config, the owner's rows alone; on a
  `ME` config its birthday source reads the owner's own row and never `sharedBirthdaysInGroups`,
  and its group event source reads only the groups the owner holds a live `group_users` row in, on
  every sync, so leaving a group takes its events off on the next one.
  Undo any of these and a teammate's absence or birthday, or a whole team's, lands in someone's personal
  Google or Microsoft calendar, where the organization's sharing shows it to people who were never
  meant to see it. `src/tests/e2e/calendarConnection.e2e.test.ts` ("refuses to attach a TEAM
  config and leaves it untouched", "holds the rule in the database too"),
  `src/services/calendarSync/tests/updateCalendarSync.test.ts` ("refuses to turn a connected config
  TEAM with a 400 the web can map"), `src/tests/e2e/calendarMarkTargetsDirty.e2e.test.ts` ("marks
  only the owner's connected ME targets whose types include the row's type") and
  `src/tests/e2e/calendarSyncApproval.e2e.test.ts` ("never touches the owner's calendar for a
  teammate's approval"), `src/tests/e2e/calendarBirthdays.e2e.test.ts` ("never writes a
  colleague's shared birthday to anyone's target") and `src/tests/e2e/calendarGroupEvents.e2e.test.ts`
  ("deletes a group's events from a removed member's target and writes them when they join again",
  "never touches a target with Group events off or one of someone outside the group") fail if the
  rule gives.

- **A team feed reads only the groups its owner is still in, at the owner's current View depth.**
  `getFeedRecords` takes a `TEAM` config's groups from `getTeamFeedScope`, the stored
  `calendar_sync_teams` ids intersected with the owner's `getScopeEntries`, on every fetch. A group
  the owner sees in full (View, admin access or manager) carries every member's days off; in any
  other group the feed carries only the owner's own, as the web reads do. Birthdays come only from
  groups seen in full, and group events from every selected group, as on the web. The stored rows
  stay as they are, so a re-join or View switched back on restores the group without editing the
  feed. Updating the feed keeps them too: `PUT /api/calendar-sync/:id` accepts a group already
  stored on that feed after the owner has left it, and checks only newly added groups against
  current membership. Read the stored ids directly and someone removed from a group keeps a
  subscription link that shows that group's days off for as long as the link lives; drop the View
  depth and a member without View reads every colleague's leave and notes through the link.
  `src/tests/e2e/calendarFeedLiveMembership.e2e.test.ts`,
  `src/tests/e2e/calendarFeedViewAccess.e2e.test.ts` and
  `src/tests/e2e/calendarFeedStaleTeamEdit.e2e.test.ts` fail if the rule gives.

## Billing config is opt-in (`src/config.ts`)

With `PADDLE_API_KEY` unset, `config.paddle` is `undefined` and `/api/billing/*` returns 503. Once
it is set, every other Paddle variable is required and startup throws without them.
`PADDLE_ENV=sandbox` combined with `NODE_ENV=production` also throws, so sandbox credentials cannot
reach production. Secrets are provisioned via Secrets Manager in `terraform/secrets.tf`; price ids
are public identifiers and ride as plain env vars.
