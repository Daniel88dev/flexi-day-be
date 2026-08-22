# Invariants

Rules that hold across `flexi-day-be` and must survive every change. Each entry says what breaks
if it is undone; most are covered by a test that fails on regression.

## Authentication (`src/utils/auth.ts`)

Better Auth with email/password, mandatory email verification, password reset by email
(`password-reset` SES template), Have I Been Pwned checks, a Drizzle session adapter, and its own
rate limit (50 requests / 10s) on top of `credentialsLimiter`.

- **Social sign-in never confers a verified address.** `buildSocialProviders` maps every Google and
  Microsoft profile to `emailVerified: false`, because both providers' claims attest the _domain_,
  not the mailbox, and a verified address unlocks invite redemption in `handlePostGroupUser`.
  Verification comes from our own confirmation email, exactly as for a password sign-up.
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

| Limiter                | Mounted on                                      | Key                            | Budget                   |
| ---------------------- | ----------------------------------------------- | ------------------------------ | ------------------------ |
| `floodLimiter`         | everything                                      | IP                             | 5000 / 5 min             |
| `apiFailureLimiter`    | `/api` (before session validation)              | IP                             | 100 **failures** / 5 min |
| `apiLimiter`           | `/api` (after the auth and dev routes)          | validated user id, IP fallback | 1000 / 5 min             |
| `credentialsLimiter`   | sign-in / sign-up / reset-password / two-factor | IP                             | 20 **failures** / 15 min |
| `passwordResetLimiter` | `request-password-reset`                        | IP                             | 5 / 15 min               |
| `otpSendLimiter`       | `two-factor/send-otp`                           | IP                             | 10 / 15 min              |
| `calendarFeedLimiter`  | `/calendars/:token.ics`                         | feed token                     | 120 / hour               |
| `paddleWebhookLimiter` | `/api/webhooks/paddle`                          | IP                             | 5000 / 5 min             |

- **`apiLimiter` keys on the session, not the IP.** Keying on the IP pools every user behind one
  office NAT, VPN or mobile CGNAT into a single allowance. Custom key generators must run IPs
  through `ipKeyGenerator` — a bare `req.ip` lets one IPv6 /64 rotate addresses freely.
- **`credentialsLimiter` covers the whole `/api/auth/two-factor` surface, not just the verify
  endpoints.** A 6-digit code is far cheaper to guess than a password, and enable / disable /
  get-totp-uri / generate-backup-codes are password oracles — without the failures-only budget, a
  stolen session cookie could brute-force the password via `POST /two-factor/disable` and switch
  2FA off. `otpSendLimiter` exists for `send-otp` for the same reason `passwordResetLimiter` does:
  the route always answers 200, so failures-only counting never triggers, and what needs bounding
  is the email it sends.
- **`passwordResetLimiter` exists because `credentialsLimiter` cannot cover that route.** Asking
  for a reset answers 200 for every input on purpose (it must reveal nothing about which addresses
  exist), and `credentialsLimiter` counts only failures — so nothing would ever increment. What
  needs bounding there is the email it sends, not guessing. It keys on the IP, so it bounds volume
  per source and **not** per address; a distributed flood at one address is still open.
- **`credentialsLimiter` sets `skipSuccessfulRequests`.** Only failures count, so a whole team
  signing in at 9am is unaffected while a password guesser burns the budget.
- **`calendarFeedLimiter` keys on the token.** Google polls every subscribed feed from a handful of
  shared ranges, so an IP key would throttle all users at once.
- **`floodLimiter` skips `OPTIONS` and `/health`.** Preflights are not attack surface (CORS `maxAge`
  caches them) and the health check must not spend a caller's budget.

The store is in-memory: counters are per-process and reset on deploy. Running more than one instance
multiplies the effective limits — that needs a shared store before scaling out.

## Organization admin boundary (`organization_users`)

See [`../CONTEXT.md`](../CONTEXT.md) for what an org admin _is_. The boundaries:

- **Owner-or-row.** The owner holds no `organization_users` row, exactly as a group's manager
  holds no `group_users` row. Querying the table alone answers half the question — always go
  through `isOrganizationAdmin`.
- **Administration, never approval.** `assertGroupAdmin` / `validateUserGroupAccess` accept org
  admins; `getGroupsWhereUserCanApprove` does not, and two routes actively defend the boundary:
  `handleUpdateGroupUsers` refuses to let any caller raise their **own** permissions (checking
  every record for them, not just the first — the array may repeat a user), and
  `handlePutGroupApprovers` refuses a caller acting `viaOrgAdmin` who names themselves. Without
  both, a delegate could invite themselves in and self-promote to approver.

  **One deliberate carve-out — records on behalf of members.** Managing a member's booking is
  administration, so org admins (like group admins) may create a booking for a member via
  `POST /create-vacation` with `userId` — including `autoApprove`, which stamps them as
  `approvedBy` — edit its per-day fields via `PATCH /api/vacation`, and cancel it
  (`resolveVacationPermissions` / `handleBulkCancelVacation` resolve admin standing through
  `resolveGroupAdmin`). Every such write is attributed (`createdByUserId` / `deletedByUserId`,
  CREATED/APPROVED/UPDATED/CANCELLED timeline events). The boundary itself stands: deciding a
  **member-submitted** request stays approver-only (`getGroupsWhereUserCanApprove` still excludes
  org admins, `autoApprove` is refused for self-bookings), and both defenses above remain.

- **Scoped to one organization.** `getAdministrableGroupIds` takes an `organizationId`; mirroring
  passes it, or someone who owns org A and is a delegate in org B could project B's leave into A.
- **The grant is scoped to membership.** `handleDeleteGroupUser` revokes it when the user leaves
  the organization's last group, under a `lockOrganization` — the count spans the org, so a group
  lock alone lets two concurrent removals each see the other's membership as live.
- **Billing stays owner-only.** `billingEmail`, granting and revoking admins all go through
  `assertOrganizationOwner`, and `/api/billing/*` resolves the org by ownership.
- **Delegates are picked from the organization's own people.** `listOrganizationAdminCandidates`
  is deliberately not a lookup by email, which would let an owner probe whether an address has an
  account.

## Billing config is opt-in (`src/config.ts`)

With `PADDLE_API_KEY` unset, `config.paddle` is `undefined` and `/api/billing/*` returns 503. Once
it is set, every other Paddle variable is required and startup throws without them.
`PADDLE_ENV=sandbox` combined with `NODE_ENV=production` also throws, so sandbox credentials cannot
reach production. Secrets are provisioned via Secrets Manager in `terraform/secrets.tf`; price ids
are public identifiers and ride as plain env vars.
