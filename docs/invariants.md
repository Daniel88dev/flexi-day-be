# Invariants

Rules that hold across `flexi-day-be` and must survive every change. Each entry says what breaks
if it is undone; most are covered by a test that fails on regression.

## Authentication (`src/utils/auth.ts`)

Better Auth with email/password, mandatory email verification, password reset by email
(`password-reset` SES template), Have I Been Pwned checks, a Drizzle session adapter, and its own
rate limit (50 requests / 10s) on top of `credentialsLimiter`.

- **Social sign-in never confers a verified address; an invite link does.** `buildSocialProviders`
  maps every Google and Microsoft profile to `emailVerified: false`, because both providers' claims
  attest the _domain_, not the mailbox. Two things verify an address: our own confirmation email,
  and following an invite link. Redeeming an email-bound **invite code** requires a verified address
  (`handlePostGroupUser`), because the admin knows the code and knowing it proves nothing about the
  mailbox. The **invite link** is different: its secret is generated at issue time, stored only as a
  SHA-256 hash, returned by no API and sent only to the invited address, so holding it is the proof.
  `handlePostInviteJoin` therefore requires a session whose address matches the invite, and marks
  that address verified in the same transaction as the join. Without this split, an
  identity-provider administrator who asserts a colleague's address could join that colleague's
  team with the code, and a legitimately invited Google or Microsoft user could not join at all.

  Verifying by link deliberately has **no settle step**: unlike a password reset, it leaves the
  account's provider links in place. On an unverified account every provider link was attached by
  whoever holds its session, either by the sign-in that created it or from inside that session,
  since implicit linking is off (next entry). That same session has now also presented the
  mailbox's secret, so both proofs point at one person and there is nobody to evict. A reset is
  different because it proves the mailbox _without_ a session, so the links it finds may belong to
  someone else. `src/tests/e2e/inviteLink.e2e.test.ts` covers the link and
  `src/tests/e2e/inviteRedemption.e2e.test.ts` the code.

- **Account linking is explicit only.** `accountLinking` trusts both providers — needed at all,
  since the false `emailVerified` above would otherwise block every link — and then sets
  `disableImplicitLinking`, so a provider can only be attached from a signed-in session via
  `POST /link-social` (Settings → Sign-in methods). Without that flag, a directory administrator
  could set a mail attribute to someone else's address and sign straight into their account.
  Keep `allowDifferentEmails` and `allowUnlinkingAll` off;
  `src/tests/utils/accountLinking.test.ts` fails if any of this is undone.
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
haveIBeenPwned check (an outbound call that fails offline) and fires a verification email.

The frontend half is gated too: `/dev-sign-in/` only builds when `NEXT_PUBLIC_DEV_TOOLS=1`, and
`pageExtensions` in `next.config.ts` keeps `page.dev.tsx` files out of production output entirely.

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

## Rate limiting (`src/middleware/limiter.ts`)

Several limiters, not one, because a single per-IP bucket both throttles real users and
under-protects the endpoints that matter:

| Limiter                | Mounted on                                                    | Key                            | Budget                   |
| ---------------------- | ------------------------------------------------------------- | ------------------------------ | ------------------------ |
| `floodLimiter`         | everything                                                    | IP                             | 5000 / 5 min             |
| `apiFailureLimiter`    | `/api` (before session validation)                            | IP                             | 100 **failures** / 5 min |
| `apiLimiter`           | `/api` (after the auth and dev routes)                        | validated user id, IP fallback | 1000 / 5 min             |
| `credentialsLimiter`   | sign-in / sign-up / reset-password / two-factor / invite link | IP                             | 20 **failures** / 15 min |
| `passwordResetLimiter` | `request-password-reset`                                      | IP                             | 5 / 15 min               |
| `otpSendLimiter`       | `two-factor/send-otp`                                         | challenge cookie, IP fallback  | 10 / 15 min              |
| `calendarFeedLimiter`  | `/calendars/:token.ics`                                       | feed token                     | 120 / hour               |
| `signedWebhookLimiter` | `/api/webhooks/paddle`, `/api/attachments/processed`          | IP                             | 5000 / 5 min             |

- **`apiLimiter` keys on the session, not the IP.** Keying on the IP pools every user behind one
  office NAT, VPN or mobile CGNAT into a single allowance. Custom key generators must run IPs
  through `ipKeyGenerator` — a bare `req.ip` lets one IPv6 /64 rotate addresses freely.
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
- **`passwordResetLimiter` exists because `credentialsLimiter` cannot cover that route.** Asking
  for a reset answers 200 for every input on purpose (it must reveal nothing about which addresses
  exist), and `credentialsLimiter` counts only failures — so nothing would ever increment. What
  needs bounding there is the email it sends, not guessing. It keys on the IP, so it bounds volume
  per source and **not** per address; a distributed flood at one address is still open.
- **The invite link endpoints ride `credentialsLimiter`.** `/api/auth/invite/*` is our own router,
  not better-auth's, so better-auth's 50/10s rule never sees it. The failures-only budget is what
  bounds a prober: an unknown secret answers 404, and a real one is 256 bits.
- **`credentialsLimiter` sets `skipSuccessfulRequests`.** Only failures count, so a whole team
  signing in at 9am is unaffected while a password guesser burns the budget.
- **`calendarFeedLimiter` keys on the token.** Google polls every subscribed feed from a handful of
  shared ranges, so an IP key would throttle all users at once.
- **`floodLimiter` skips `OPTIONS` and `/health`.** Preflights are not attack surface (CORS `maxAge`
  caches them) and the health check must not spend a caller's budget.

The store is in-memory: counters are per-process and reset on deploy. Running more than one instance
multiplies the effective limits — that needs a shared store before scaling out.

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

See [`../CONTEXT.md`](../CONTEXT.md) for what an org admin _is_. The boundaries:

- **Owner-or-row.** The owner holds no `organization_users` row; `organizations.ownerUserId` is
  the other half of the answer. Querying the table alone answers half the question — always go
  through `isOrganizationAdmin`, and for group standing through the `groupUser/groupAccess.ts`
  resolvers, which credit the manager as well as the membership row.
- **Administration, never approval.** `assertGroupAdmin` / `validateUserGroupAccess` accept org
  admins; `getGroupsWhereUserCanApprove` does not, and two routes actively defend the boundary:
  `handleUpdateGroupUsers` refuses to let any caller raise their **own** permissions (checking
  every record for them, not just the first — the array may repeat a user), and
  `handlePutGroupApprovers` refuses a caller acting `viaOrgAdmin` who names themselves. Without
  both, a delegate could invite themselves in and self-promote to approver. The group's manager
  sits outside this boundary on purpose: they administer their group in their own right
  (`viaOrgAdmin: false`) and `getGroupsWhereUserCanApprove` already accepts them, so a manager
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
- **The grant is scoped to membership.** `handleDeleteGroupUser` revokes it when the user leaves
  the organization's last group, under a `lockOrganization` — the count spans the org, so a group
  lock alone lets two concurrent removals each see the other's membership as live.
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

## Employment roster (`employments`, `src/services/employment/`)

- **The roster is written by the link, never by a screen.** `syncEmployment` hangs off the service
  functions that change the four links of ADR 0004 — `ensureOrganizationForUser`,
  `grantOrganizationAdmin`, `removeOrganizationAdmin`, `createGroup`, `updateGroupManager`,
  `deleteGroup`, `createGroupUser`, `deleteGroupUser` — not off the controllers that call them. A
  new join path therefore keeps the roster in step without knowing the roster exists, which is the
  whole risk the ADR names.
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
- **Reading an Employment is wider than belonging to one.** `attendanceAccess.ts` is the only
  statement of who may read and correct one, and it deliberately leaves the Employment of anybody
  who belongs to no group — a manager whose own group holds no membership row for them, say — to
  org admins alone, because a group admin's scope reaches only people who hold a `group_users` row.

## Billing config is opt-in (`src/config.ts`)

With `PADDLE_API_KEY` unset, `config.paddle` is `undefined` and `/api/billing/*` returns 503. Once
it is set, every other Paddle variable is required and startup throws without them.
`PADDLE_ENV=sandbox` combined with `NODE_ENV=production` also throws, so sandbox credentials cannot
reach production. Secrets are provisioned via Secrets Manager in `terraform/secrets.tf`; price ids
are public identifiers and ride as plain env vars.
