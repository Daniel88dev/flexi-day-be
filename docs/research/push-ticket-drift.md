# Push ticket drift: T-67 and T-68 against main

Fenro T-327, for the map T-324. The two push tickets were written on 2026-09-26:
[T-67](https://www.fenro-dashboard.com/tasks/T-67) (be: push registrations and APNs sender) and
[T-68](https://www.fenro-dashboard.com/tasks/T-68) (rn: push client). This note checks every claim
and file they name against `origin/main` of `flexi-day-be` (at `08e06c2`, #269) and `flexi-day-rn`
(at `0447210`, #96), read on 2026-10-17.

Sources are the code and the repos' own docs. Paths are relative to the repo named in each section.

## Summary

The design in both tickets still fits the code. Native sessions, the notification table, the
English copy, the explainer and the href resolver are all where the tickets expect. What changed:

1. **A registration does not always end when the phone signs out.** The session row, and with it
   the registration, survives a sign-out the server never received and every cookie voided by the
   Better Auth secret rotation. The phone then keeps getting the previous user's notices on the lock
   screen. ADR 0006 and both tickets say a 401 needs no server-side cleanup. That is wrong for
   these cases.
2. **Three phone flows replace the session row while the app stays signed in:** changing the
   password from the phone, and turning two-factor on or off. Each deletes the registration by
   cascade. T-68 re-registers only on launch, so push stops until the next cold start.
3. **The auto-closed notice does not go through `deliver()`.** It has its own notifier. The one
   shared insert point is `createNotification`, and `deliver()` throws away the rows it inserts,
   so it has no notification ids to push.
4. **There is no unread count query** for `aps.badge`.
5. **T-68's "add the `expo-notifications` config plugin" is wrong.** Prebuild already applies it.
   The work is deleting `plugins/without-push-entitlement.js`.
6. **The `.p8` path in T-67 is out of date.** T-325 recommends setting the secret value outside
   Terraform. T-328 decides it. The Key ID in T-67's note is the Sandbox-only key the map replaces.

## Backend: Native sessions

**How a Native session is told apart.** A session row with a non-null `device_id`.
`src/db/schema/auth-schema.ts` adds `deviceId`, `platform` and `appVersion` to `session`. The
create hook in `src/utils/auth.ts` (`databaseHooks.session.create.before`) stamps them from the
`x-client-device-id` header through `nativeSessionStamp` in `src/utils/nativeSession.ts`, with a
ten-year expiry. Every native sign-in path gets the stamp, because the hook is path-agnostic:
password, the three two-factor verify endpoints, native Google, Microsoft and Apple id-token
sign-in (be#250), and the dev sign-in ticket (`docs/invariants.md`, "Dev sign-in ticket"). Web and
`dev:login` sessions have a null `device_id`.

**What Express sees.** `authSession` in `src/middleware/authSession.ts` puts `sessionId` and, on a
Native session only, `deviceId` on `req.auth`. Both values a registration endpoint needs are
already there.

**The phone-only refusal already exists.** `assertNativeSession` in `src/utils/nativeSession.ts`
answers 403 with `reason: NATIVE_SESSION_REQUIRED` for a session without a device id. Today it guards
`POST /api/users/me/apple-authorization`
(`src/controllers/users/handlePostAppleAuthorization.ts`). `docs/social-sign-in.md` ("Apple
authorization") already says push registration reuses it.

**Id type.** `session.id` is `text`, a 32-character alphanumeric better-auth id, not a UUID. The
registration's `session_id` column must be `text` with a foreign key to `session.id`. A `z.uuid()`
on it would pass tests seeded with UUIDs and fail in production.

**Does the cascade work?** Yes. Every path that ends a session deletes the row:

| What ends the session                                    | Where                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Sign-out, `/revoke-session(s)`, `/revoke-other-sessions` | better-auth `internalAdapter.deleteSession`                                |
| Password reset                                           | `revokeSessionsOnPasswordReset: true` in `src/utils/auth.ts`               |
| Password change with `revokeOtherSessions`               | better-auth `update-user`; `docs/invariants.md`                            |
| Another sign-in on the same phone                        | `nativeSessionEvictionPlugin` in `src/utils/auth.ts`, deletes by device id |
| A request from the wrong device                          | `hooks.before` in `src/utils/auth.ts`, `SESSION_DEVICE_MISMATCH`           |
| Two-factor enable or disable                             | better-auth `two-factor` plugin: creates a new session, deletes the old    |
| Account deletion                                         | `session.user_id` cascades from `user`                                     |

None of these is a soft delete, so `ON DELETE CASCADE` fires every time.

**What ends a Native session that the tickets don't list.**

- The device mismatch deletion.
- Two-factor enable and disable. The phone manages two-factor from Settings (rn#48), and
  better-auth swaps the row: `createSession` then `deleteSession` in
  `node_modules/better-auth/dist/plugins/two-factor/{index,otp/index,totp/index}.mjs`.
- A password change made _on the phone_. The phone sends `revokeOtherSessions: true`
  (`src/lib/session/use-change-password.ts` in flexi-day-rn), and better-auth deletes every row and
  creates one new session (be `docs/invariants.md`, "changing the password").
- Account deletion.

In the last three the phone stays signed in with a new session id, and the registration is gone.

**What leaves a signed-out phone with a live registration.** This is the gap the tickets and
ADR 0006 miss:

- **Sign-out the server never got.** `src/lib/session/sign-out.ts` in flexi-day-rn calls the
  server, then wipes whatever the answer. Its comment says a server that refuses or never answers
  "leaves a row behind". The row keeps its registration.
- **Secret rotation.** `terraform/secrets.tf` rotates the Better Auth secret every
  `better_auth_rotation_days` (default 90, `terraform/variables.tf`). Every cookie stops verifying
  and every phone wipes on its next 401, but no session row is deleted. Native rows live ten years.

In both cases APNs keeps delivering the old user's notices, which name people and leave dates, to
a phone showing the welcome screen. The next sign-in on that phone evicts the old row by device id,
so the leak lasts until then. The ADR's argument holds for sessions the server ends. It doesn't
hold for a phone that lets go of a session the server still has.

## Backend: delivery path

**`deliver()` is still the path for every request notice.** `src/services/vacation/vacationNotifier.ts`
has seven notifiers that all end in `deliver()`: requested, booked on behalf, updated, decision,
comment, cancelled, bulk cancelled. Callers run them after the transaction commits:
`handlePostVacation.ts`, `handleUpdateVacation.ts`, and `runTransition` in
`src/services/vacation/vacationTransitions.ts` (`await transition.notify(rows)` after
`db.transaction`).

Two things to know before hooking push there:

- `deliver()` inserts with `Promise.all(... createNotification(...))` and drops the returned rows.
  Push needs each row's `id` for `notificationId`, so `deliver()` has to keep them.
- Callers `await` the notifier before answering the request. Email already adds latency there.
  APNs calls per recipient would add more unless the push is not awaited.

**The auto-closed notice is a separate path.** `notifySessionAutoClosed` in
`src/services/attendance/attendanceNotifier.ts` calls `createNotification` directly. The sweep
`sweepAttendanceCeilings` in `src/services/attendance/attendanceCeilings.ts` calls it once per
session it closed, after that close committed. It shipped as T-45 (be#216, migration `0020`).
Its title is "Clock closed automatically", its href `/my-attendance/?date=<businessDate>`.

**The one shared insert point** is `createNotification` in
`src/services/notification/notificationServices.ts`. Both notifiers call it and nothing else
inserts into `notifications`. A push hook placed there catches every kind, but it would run inside
any transaction a future caller passes as `tx`, so a wrapper beside it is safer than a hook inside
it.

**No new notification kinds since the tickets.** `notificationType` in
`src/db/schema/notification-schema.ts` has six values. `CalendarConflict` and `BalanceLow` are
declared and never raised. Calendar direct sync (`src/services/calendarSync/`) raises no
notification. Billing sends only the grace email (`src/services/billing/billingNotifier.ts`).
Attendance self-service added none.

## Backend: copy and language

**The copy exists as stored text.** Each notification row holds `title` and `body` written by the
backend in English. `GET /api/notifications` (`src/controllers/notification/handleGetNotifications.ts`)
returns them as is, and the phone shows them as is. Push can reuse the same two strings.

**Notification ids are UUIDs** (`generateRandomUUID`). Request hrefs are absolute against
`EMAIL_APP_URL` (`buildRequestUrl`), attendance hrefs relative. The phone's resolver handles both.

**Language.** `user_settings.language` (`app_language` enum `en`/`cs`, migration `0025`) exists and
is read by `getUserLanguage`. Calendar sync uses it (be#268). The notifier stays English on purpose:
be#269 (T-323) moved it onto `ENGLISH_RECORD_TYPE_LABELS` in
`src/services/recordType/recordTypeLabels.ts` because the emails are English only. A Czech user gets
an English push, the same as their bell rows today. This matches T-30 §8.

## Backend: unread count

There is no count query. `listNotificationsForUser(userId, true)` returns the unread rows, and the
list endpoint has no count field. The index `notifications_user_unread_idx` on
`(user_id, read_at)` serves a `count(*) where read_at is null`. T-67 needs a new
`countUnreadNotifications(userId)`, read per recipient after the insert.

## Backend: config and Terraform

**Config pattern.** `src/config.ts` has one `parseX()` per optional feature returning `undefined`
when its switch is unset and throwing at boot when the switch is set without the rest
(`parsePaddle`, `parseCalendarSync`, `parseDevTools`). An `apns` block fits that shape: no key, no
APNs, so the log sender.

**Overlap with Sign in with Apple.** `APPLE_TEAM_ID` (`S6FC47MMXJ`) and
`APPLE_APP_BUNDLE_IDENTIFIER` (`com.flexiday.app`, also the APNs topic) already exist for Sign in
with Apple, behind the `APPLE_CLIENT_ID` switch. APNs needs the same two values and a different key.
The rewrite should decide whether APNs reads those or gets its own `APNS_*` variables. Its own keep
push independent of the sign-in switch.

**ES256 signing exists.** `src/utils/appleClientSecret.ts` signs Apple's client secret as an ES256
JWT with `node:crypto`, checks the key is EC P-256, and re-mints below five minutes left. The APNs
provider token is the same shape (`iss` = team, `kid` = key id, ≤ 1 hour). Nothing in the repo uses
`node:http2` yet, and there is no APNs code.

**Local dev.** Email uses a log sender only under test (`src/services/email/index.ts`), so "log
sender when APNs config is absent" is a new rule, not a reused one.

**Terraform.** `docs/terraform.md` "Optional blocks" and "Sign in with Apple" give the shape: a
switch variable defaulting to `""`, `count` on the secret, env merged in with `merge()`,
`lifecycle { precondition }` in `secrets.tf` (the `apple_private_key` secret version in `terraform/secrets.tf`), the
ARN on the instance role (`terraform/iam.tf` line 79), and the secret version in the service's
`depends_on`. The doc still tells the reader to pass the `.p8` as `TF_VAR_*` at apply. T-325 found
that puts the key in state and recommends setting the value outside Terraform. T-67 has to follow
whatever T-328 decides, for the APNs key and for the Apple sign-in key alike.

## Backend: glossary and ADR

- ADR 0006 is in place: `docs/adr/0006-push-registrations-belong-to-the-native-session.md`.
- The **Notification** and **Push registration** rows are in place, in `GLOSSARY.md` (renamed from
  `CONTEXT.md` in be#261). T-67 still says `CONTEXT.md`.
- The **Native session** row lists sign-out, password reset, a password change made elsewhere and a
  sign-in on the same phone. It leaves out two-factor toggles and the device mismatch.
- `docs/invariants.md` has no push entry yet. The new registration rule and the cascade belong
  there with a test that fails if they go, like the other Native session entries.
- `src/tests/e2e/helpers/nativeSessionHelpers.ts` already opens Native sessions for e2e tests.

## Phone

**`expo-notifications` and its plugin.** `expo-notifications ~57.0.22` is installed
(`package.json`). SDK 57 prebuild applies its config plugin whenever the package is installed
(T-63's discovery note), which writes `aps-environment`. `plugins/without-push-entitlement.js` is
listed last in `app.json` and deletes it again. `docs/releasing.md` warns that while the plugin
strips the entitlement, every `eas build` turns Push off on the App ID through capability sync.

**Already built by T-63 (rn#46):**

- The one-time explainer, route `notifications-intro`
  (`src/components/reminders/notifications-intro.tsx`), shown by `useNotificationsIntro` in
  `src/lib/reminders/use-clock-reminders.ts`. Its copy covers "Request updates: When your time off
  is approved, declined or commented on" and clock reminders. It doesn't mention approver notices
  or the auto-closed notice.
- The permission source in `src/lib/reminders/permission.ts`, wired in
  `src/lib/reminders/device.ts`. The request already asks for `allowBadge: true`.
- A global `Notifications.setNotificationHandler` in `src/lib/reminders/device.ts` showing banners
  in the foreground with `shouldSetBadge: false`. It applies to every notification, pushes
  included. `expo-notifications` keeps one handler, so the push client has to extend this one, not add a second.
- `useClockReminderTaps` reads `useLastNotificationResponse` and acts only on `clock-*`
  identifiers. A push tap handler sits beside it on the same response.

**Already built by T-64 (rn#49):**

- The href resolver `notificationRoute` in `src/lib/notifications/route.ts`.
- `followNotificationRoute` in `src/lib/notifications/open.ts`. It assumes the user is on the
  notification list: for an attendance link it calls `router.back()` first, and a `list` route is a
  no-op. From a push tap neither is right. T-64's handoff says the push client needs its own entry
  that opens `/notifications` for a list route.
- Mark read through `useNotificationWrites` in `src/lib/query/notifications.ts`, and the bell's
  unread dot (`useHasUnreadNotifications`).

**Not built: badge.** Nothing sets or clears the app badge.

**Signed-out wipe.** `src/lib/session/signed-out-wipe.ts` clears the cookie jar, the session cache,
the Local store, the query cache and clock reminders, and signs the Google SDK out (rn#86). No badge
step. The glossary row is in `GLOSSARY.md` now (renamed from `CONTEXT.md` in rn#95) and already
names the query cache and the Google SDK.

**Foreground refresh.** Request data reaches the screens through the Local store's sync pull, not
only TanStack queries. `createPullTriggers` in `src/lib/local-store/triggers.ts` debounces
`"foreground"` pulls for 30 s and runs `"refresh"` at once. A push in the foreground needs a pull
plus invalidating `qk.allNotifications()`, not only "refetch the affected queries".

**Environment.** `expo-application ~57.0.3` is installed. Its
`getIosPushNotificationServiceEnvironmentAsync()` reads `aps-environment` from the embedded
profile, which tells the phone whether its token is sandbox or production. Which value a TestFlight
build carries is T-326's question.

**Team and docs.** `app.json` already has `ios.appleTeamId: "S6FC47MMXJ"`, the paid team.
`docs/device-testing.md` lines 7-8 say the signing sections still describe the free team and that
T-68 rewrites them.

**Unrelated header with a similar name.** The phone sends `x-client-session-id`
(`src/lib/session/client-headers.ts`). It is a per-launch log id, not the auth session.

## T-67: be push registrations and APNs sender

**Still holds**

- Own table keyed by Native session id with a cascading delete, token plus environment.
  `session.id` is `text`, and every session end is a hard delete (see the table above).
- Native-only endpoints. `assertNativeSession` (`src/utils/nativeSession.ts`) and
  `req.auth.sessionId` (`src/middleware/authSession.ts`) are ready to use.
- Dead-token removal on `410` or `BadDeviceToken`.
- Sender straight to APNs with a `.p8` ES256 JWT, topic `com.flexiday.app`. The signing pattern is
  in `src/utils/appleClientSecret.ts`.
- Push after commit, best effort, never retried, failures logged and swallowed.
- Passive interruption level for the auto-closed notice.
- Copy is the stored English title and body (`notifications.title`, `notifications.body`).
- A log sender when APNs config is absent.
- Blockers T-45, T-46 and T-47 are done.

**Wrong**

- "Push from the one notification delivery path." There are two: `deliver()` in
  `src/services/vacation/vacationNotifier.ts` and `notifySessionAutoClosed` in
  `src/services/attendance/attendanceNotifier.ts`. Both call `createNotification` in
  `src/services/notification/notificationServices.ts`.
- `deliver()` has no notification ids to push: it drops the rows `createNotification` returns.
- "The `.p8` as a Secrets Manager secret", passed at apply. The secret stays, but how its value
  gets there waits on T-328 (T-325 recommends outside Terraform).
- The Key ID `SCNLNZW72W` in the journal note is the Sandbox-only key. The map replaces it with a
  new Sandbox & Production key.
- "ADR 0006 and the glossary rows are in flexi-day-be#213": they are, but the glossary file is
  `GLOSSARY.md` now.
- "A registration ends with its session" covers fewer cases than it implies. A signed-out phone
  keeps receiving pushes when its sign-out never reached the server, or after a secret rotation
  (`terraform/secrets.tf`, default 90 days).

**Missing**

- A rule for the signed-out phone that still has a live row. Options for the grilling: the phone
  deletes its registration before sign-out (fails offline), the Signed-out wipe unregisters the app
  from APNs, or the server deletes all sessions on secret rotation. ADR 0006 needs amending with
  whichever is chosen.
- An unread count query for `aps.badge` (`countUnreadNotifications`, on
  `notifications_user_unread_idx`).
- Whether APNs reuses `APPLE_TEAM_ID` and `APPLE_APP_BUNDLE_IDENTIFIER` or has its own `APNS_*`
  variables.
- Whether push is awaited in the request path. `runTransition` and the controllers wait for the
  notifier before answering.
- A `docs/invariants.md` entry for push registrations, with a test that fails if the cascade or the
  native-only check goes.
- The registration endpoint must be an idempotent upsert, because the phone calls it on every launch
  and after every session swap.

## T-68: rn push client

**Still holds**

- Registration with `getDevicePushTokenAsync`, sandbox or production, upserted while signed in and
  permitted, deleted when permission is revoked.
- Reuse the explainer and prompt from T-63; no second prompt.
- Taps mark read and route through the T-64 resolver (`src/lib/notifications/route.ts`).
- A foreground push shows a banner.
- Badge from `aps.badge` and from the API on foreground. Nothing exists yet.
- The Signed-out wipe clears the badge.
- `xcrun simctl push` for taps and the foreground banner; a real device for delivery.
- Update `docs/device-testing.md` (its lines 7-8 say T-68 rewrites the signing sections).
- Blockers T-63, T-64 and T-47 are done. T-67 is not.

**Wrong**

- "Add the `expo-notifications` config plugin." Prebuild already applies it. The work is removing
  `./plugins/without-push-entitlement` from `app.json` and deleting
  `plugins/without-push-entitlement.js`. That also stops `eas build` turning Push off on the App ID
  (`docs/releasing.md`).
- "Update `ios.appleTeamId` if the Apple setup changed it." Already done: `S6FC47MMXJ`.
- "Upsert on every launch" is not enough. A password change or a two-factor toggle on the phone
  replaces the session and drops the registration by cascade. The phone must upsert again whenever
  its session id changes, or on every foreground.
- "The server side needs no call, because registrations cascade with the session." Not after a
  sign-out that failed (`src/lib/session/sign-out.ts` says so) or a secret rotation. See T-67.
- Reusing `followNotificationRoute` for taps. It assumes the list is open (`router.back()` for
  attendance, no-op for a list route). A push tap needs its own follower, and a list route must
  open `/notifications`.
- "Refetch the affected queries." Request data lives in the Local store, so the foreground push
  needs a sync pull (`"refresh"` reason bypasses the 30 s debounce in
  `src/lib/local-store/triggers.ts`) plus invalidating `qk.allNotifications()`.
- The glossary file is `GLOSSARY.md`, not `CONTEXT.md`.

**Missing**

- The single `setNotificationHandler` in `src/lib/reminders/device.ts` has `shouldSetBadge: false`
  for every notification. The push client has to extend it, and decide badge handling in the
  foreground.
- A push tap handler beside `useClockReminderTaps` on the same `useLastNotificationResponse`,
  including a cold start, where the request screen waits for the store to open (rn#66).
- How the phone knows its environment. `expo-application`'s
  `getIosPushNotificationServiceEnvironmentAsync()` is already installed. T-326 covers what a
  TestFlight build carries.
- The explainer copy mentions only the requester's updates and clock reminders, not approver
  notices or the auto-closed notice (`src/i18n/en.ts`, `reminders.intro`).
- The phone's part of the signed-out-phone rule from T-67, once it is decided.
