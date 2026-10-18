# Calendar direct sync

The rules behind the Calendar connection, Sync target, Sync ledger and Capability rows in
[`GLOSSARY.md`](../GLOSSARY.md). A user on a paid plan connects their own Google or Microsoft account
from a `ME` calendar config, and the backend writes that user's approved absences into the account's
primary calendar within seconds of a change, along with the events of the groups the user is in.
The `.ics` feed is untouched and stays free.

Code lives in `src/services/calendarConnection/` (consent, tokens, targets) and
`src/services/calendarSync/` (builder, drivers, engine, queue, dirty marking). The invariants that
keep teammates' records out of a personal calendar are in
[`invariants.md`](invariants.md#calendar-direct-sync-srcservicescalendarconnection).

## What gets written

The engine writes the records the `.ics` feed would show for the same config: `getFeedRecords` on a
`ME` config. That is the owner's approved, live rows, twelve months back and everything ahead, and,
with the config's Group events row on, the events of every group the owner is a live member of,
and with its Birthdays row on, the owner's own birthday. One provider event stands for one day row,
one group event or one recurring group event. Attendance sessions and colleagues' birthdays are
never written.

A row with both `startTime` and `endTime` is timed and spans those times in the target's time zone.
Every other row is a full day, `halfDay` included. A timed row whose end is at or before its start is
cut at the next midnight.

| Row         | Google, `STATUS` or `UNKNOWN`                                                   | Google, `PLAIN`                 | Microsoft, any account                       |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------- |
| Full day    | `workingLocation`, `customLocation` labeled with the type, all-day, transparent | `default` all-day event, opaque | `showAs: oof`, all-day, midnight to midnight |
| Timed       | `outOfOffice` with `dateTime` and zone, `autoDeclineMode: declineNone`, opaque  | `default` timed event, opaque   | `showAs: oof`, timed                         |
| Home office | `workingLocation` `homeOffice`, all-day even when the row has times             | nothing                         | nothing                                      |

- The title is the record type's label. Labels come from one table, `recordTypeLabels()` in
  `recordType/recordTypeLabels.ts`, which the `.ics` feed, the config API, emails and the Excel
  export use too. Calendar titles follow the owner's `language` in user settings, which the web
  writes; null or an unknown value means English. Emails and the export stay English. Changing the
  language changes every title, so the next sync patches each event once.
- The description is the record's note followed by "Synced from Flexi Day". Working-location events
  carry the label only.
- Google events carry `flexiDayVacationId` and `flexiDayConfigId` in `extendedProperties.private`.
- Working-location events are `visibility: public`.
- Microsoft events carry `transactionId` set to the ledger row id, so Graph drops a repeated insert.
- Reminders are off: `reminders.useDefault: false` on Google default events, `isReminderOn: false` on
  Microsoft.
- The zone is the target's IANA name, for both providers. Graph accepted `Europe/Prague` in the
  OPS-2 probe (T-298), so there is no Windows-name map. The API refuses offsets such as `+01:00`.
- A config has one zone, `calendar_sync.time_zone`, which the `.ics` feed and the target share. A
  config created without one, and every config that predates the column, is in `Europe/Prague`.
  Connecting a target overwrites it with the browser's zone, `PUT /api/calendar-sync/:id` changes
  it when the body names one, and turning the target off leaves it.

### Group events

With `includeGroupEvents` on, a target carries the live events of every group the owner is a live
member of, whoever created them. Membership is read on every sync, so leaving a group takes its
events off the calendar on the next one. A deleted event (its tombstone) never goes out. The ledger
keys an event `ge:<groupEventId>` with kind `GROUP_EVENT`.

- Every event is a plain free event on every capability, never Out of office or a working
  location: Google `eventType: default`, `transparency: transparent`, `reminders.useDefault:
false`; Microsoft `showAs: free`, `isReminderOn: false`.
- The title is the event's title. The description is its note, then a line naming the group
  ("Group: Dev Team", "Skupina: Dev Team" in Czech), then "Synced from Flexi Day".
- Times are floating wall clock. A timed event is a local `dateTime` stamped with the target's zone;
  an all-day event or run of days is all-day, its end the day after the last day.
- A recurring group event goes out as one series. Google gets `recurrence` with the same `RRULE`
  and `EXDATE` lines the `.ics` feed writes (`recurrenceLines` in `utils/ics.ts`), so a skipped
  date is a patch. Graph gets a `patternedRecurrence`: `daily`, `weekly` with `daysOfWeek` and
  `firstDayOfWeek: monday`, `absoluteMonthly` on the start's day (Graph lands day 29 to 31 on a
  short month's last day itself), `relativeMonthly` with `index` `first` to `fourth` or `last`,
  `absoluteYearly`; the range is `endDate` on the rule's end or `noEnd`.
- Graph has no exception dates, so after a series goes in the engine cancels each skipped date with
  the driver's `cancelOccurrence`: one `GET /me/events/{id}/instances` over that day, then a
  `DELETE` of the occurrence that falls on it. The read sends `Prefer: outlook.timezone` with the
  target's zone and matches on the date part of each start, an all-day occurrence by its date
  directly, since its midnight read as UTC lands a day early west of UTC.
- A change to a Graph series' start, end, rule or skipped dates deletes it and inserts it again
  before the cancels, so the cancelled dates always equal the skipped dates. Any other change, a
  title or a note, patches the series without its start, end or rule, which keeps its provider id
  and the user's own reminders. A cancel that fails leaves the row's hash unmatched, and the next
  sync replaces the series again. A replace costs 2 calls plus 1 to 2 per skipped date.
- Google events carry `flexiDaySourceKey` and `flexiDayConfigId` in `extendedProperties.private`.
- The zone Graph gets passes through `graphTimeZone` in `eventBuilder.ts`, which returns the IANA
  name as is. The T-348 probe has not shown yet that Graph takes an IANA zone on a recurring event;
  if it refuses, that function maps to the Windows name and nothing else changes.
- A write to a group event, every scope of create, edit and delete, marks the targets of the
  group's live members with Group events on. Joining a group marks the new member's targets and
  leaving marks the leaver's. Turning the row on or off marks the target too.

### Birthdays

With `includeBirthdays` on, a target carries the owner's own birthday, shared or not, and nobody
else's. It goes out as one free all-day yearly series with no end, titled "Birthday" ("Narozeniny"
in Czech) and never with the year or an age. The ledger keys it `bd:<userId>` with kind `BIRTHDAY`.

- The series starts on the birthday's first occurrence on or after the row's `createdAt`, the same
  `DTSTART` the `.ics` feed writes, so it never moves.
- Google: a `default` event, `transparency: transparent`, `reminders.useDefault: false`,
  `recurrence: ["RRULE:FREQ=YEARLY"]`, and `extendedProperties.private` with `flexiDaySourceKey` and
  `flexiDayConfigId`. A 29 February birthday repeats as `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1`, so it
  lands on 28 February in other years.
- Microsoft: `showAs: free`, `isAllDay: true`, `recurrence` with an `absoluteYearly` pattern on the
  birthday's month and day and a `noEnd` range.
- A 29 February birthday goes to Graph as one series on day 29. The T-348 probe has not shown yet
  that Graph lands it on 28 February in other years. If it does not, `graphBirthdaySeries` in
  `calendarSync/birthdaySeries.ts` switches to `leapDayFallbackSeries`: four `interval: 4` series,
  keyed `bd:<userId>:0` to `:3`.
- Saving or removing a birthday marks the owner's targets with Birthdays on. Turning the row on or
  off through `PUT /api/calendar-sync/:id` marks the target too.

Writes go to the primary calendar only. There is no calendar picker.

## Capability and the fall-back

A connection starts `UNKNOWN`, and the builder treats that as `STATUS`. Google answers a status
event on an account without the features with HTTP 400 `malformedWorkingLocationEvent` or
`malformedOutOfOfficeEvent`. The driver reports that as `capability_refused`. The engine then sets
the connection to `PLAIN`, rebuilds every event and runs the whole diff once more in the same run.
The first status write that succeeds while `UNKNOWN` sets `STATUS`. A reconnect resets the
capability to `UNKNOWN`, so the next sync probes again. Microsoft has no capability to learn and
stays `UNKNOWN`.

Accounts that end up `PLAIN`: personal Gmail, Workspace Business Starter, and any edition whose
admin turned the features off.

## Connection lifecycle

1. **Start.** `POST /api/calendar-sync/connections/:provider/start` with `{ configId, timeZone }`
   answers `{ url }`. It refuses a provider whose switch is off (404 `CALENDAR_SYNC_PROVIDER_OFF`),
   a `TEAM` config (400 `CALENDAR_SYNC_TEAM_SCOPE`), a config already syncing to the other provider
   (409 `CALENDAR_SYNC_TARGET_EXISTS`), and a user no paid organization covers (402
   `CALENDAR_SYNC_PLAN_REQUIRED`). The `state` in the URL is signed, see the invariants.
2. **Consent.** Google asks for `calendar.events.owned` with `access_type=offline` and
   `prompt=consent`, because Google returns a refresh token only on consent. Microsoft asks on the
   `common` authority for `Calendars.ReadWrite offline_access` with `prompt=select_account`. Forcing
   consent there fails in tenants where only an admin may consent, even after the admin did (T-307).
3. **Callback.** `GET /api/calendar-sync/connections/:provider/callback` verifies the state,
   exchanges the code, checks the calendar scope was granted, stores the tokens encrypted in a
   `calendar_connection` row, attaches the config as a target, marks every target on the connection
   due and redirects to `{APP_URL}/calendar-sync/?connected=<provider>&config=<id>`. Every failure
   redirects with `?error=` and one of `state_invalid`, `provider_off`, `consent_denied`,
   `provider_error`, `config_not_found`, `team_scope`, `target_exists`, `scope_denied`,
   `exchange_failed` or `server_error`, plus `provider=<provider>` from the callback path, so the
   web can word a Microsoft `consent_denied` differently even when consent finished in another tab.
4. **Refresh.** A token within 60 seconds of expiry is refreshed before use. Microsoft rotates the
   refresh token on every refresh, and the new one is saved.
5. **Needs reconnect.** A refresh that fails with `invalid_grant`, or Microsoft's
   `interaction_required`, sets the connection to `NEEDS_RECONNECT` and stops every target on it
   with `lastError = "auth_revoked"`. Events already written stay. Running the consent again revives
   the same row as `ACTIVE` and `UNKNOWN` and re-syncs each target in full.
6. **Target off.** `DELETE /api/calendar-sync/:id/target` deletes every event the ledger holds for
   that target at the provider, then the ledger rows and the target columns, all but the zone.
   Deleting a config with
   a target does the same first. With the provider's switch off the purge is local only: the ledger
   and the target go, and the events stay in the user's calendar.
7. **Disconnect.** `DELETE /api/calendar-sync/connections/:provider` purges every target on the
   connection, revokes the refresh token at Google, and deletes the row. Microsoft has no revoke
   endpoint. The purge and the revoke reach the provider only while its switch is on. With it off,
   the row goes, the written events stay in the user's calendar and the token stays live at Google
   until it lapses. Sign-in `account` rows are never read or written. Account deletion runs the
   same disconnect for every connection the user has; see
   [`account-deletion.md`](account-deletion.md#calendar-connections).

Other routes: `GET /api/calendar-sync/connections` lists the caller's connections and which
providers are on, `PUT /api/calendar-sync/:id/target` changes the zone and marks the target due, and
`POST /api/calendar-sync/:id/target/sync` is Sync now. Sync now answers 409
`CALENDAR_SYNC_NEEDS_RECONNECT` on a broken connection and 402 without a paid plan.

## Plan

Direct sync is Pro. A user is entitled while any organization covering one of their groups resolves
to a paid, writable plan (`isCalendarSyncEntitled`). When that lapses, a sync stops before any
provider call with `lastError = "plan"`, and the target reads `PAUSED`. Nothing is written or
deleted. The target syncs again on the next change to its records or on Sync now once a plan is
active. The callback does not check the plan, because the next sync does.

## Dirty marking

After the commit, next to the notifier calls, `markCalendarTargetsDirty(rows)` runs one `UPDATE`.
It sets `syncDueAt` on every live `ME` target whose owner is a row's user, whose connection is
`ACTIVE` and whose type list includes the row's type, and hands those targets to the queue. Rows
approved neither before nor after the change mark nothing. It never throws, so a committed approval
never turns into a 5xx.

Callers:

- `vacationTransitions.ts`, for approve, reject and cancel, single and bulk. It passes the rows as
  loaded and as changed, so rejecting a pending request marks nothing. Comment changes nothing.
- `handlePostVacation`, on the auto-approve path only. Other bookings start pending.
- `handleUpdateVacation`, with the rows before and after the edit, so a retyped row leaves the old
  type's targets too.
- `updateCalendarSync` marks its own target due when the config's type list, zone, Group events row
  or Birthdays row changes, and `handleUpdateCalendar` enqueues it.

`markBirthdayTargetsDirty(userId)` does the same for a birthday write: `PUT` and `DELETE
/api/users/me/birthday` call it after the write, and it marks the user's own targets with Birthdays
on. A colleague's birthday marks nothing, because no target carries it.

`markGroupEventTargetsDirty(groupId)` runs after the commit of `POST`, `PATCH` and `DELETE
/api/group-events`, and marks the targets with Group events on of everyone holding a live
membership of the group. `markMemberGroupEventTargetsDirty(userId)` runs after a membership is
added or removed: `handleDeleteGroupUser` for the removed member, and for the joining one
`handlePostGroup` (the creator's row), `handlePostGroupUser` (invite code), `handlePostInviteJoin`
(invite link) and `handlePostInviteSignUp`. Sign-up with a new team marks nothing: the account was
created in the same request and has no target yet. The dev seed adds members without marking.

Every marker shares one `UPDATE` helper, `markTargetsDue`, and differs only in the condition that
picks the configs.

## The queue

`createSyncQueue` in `enqueueSync.ts` is in-process. There is no cron, no SQS and no worker.

- A target waits 5 s after its first change, and later changes in that window join the same run.
- One sync runs per target at a time. A change during a run schedules another run 5 s after it.
- A failed run retries after 5 s, 30 s, 5 min and 30 min. The fifth failed run gives up and logs
  `calendar_sync.gave_up`. `syncDueAt` stays set, so the next change or Sync now starts over.
- A throttled run waits the provider's `Retry-After`, or the next backoff step without one, and does
  not count as an attempt. The queue gives up after six throttled retries in one cycle.
- A new change cuts a pending backoff short.
- At boot, `startCalendarSyncQueue` enqueues every target with `syncDueAt` set. That marker is what
  survives a restart.
- Under `NODE_ENV=test` there is no process queue. Tests install one with `installCalendarSyncQueue`
  and run it with `drain()`.

App Runner may run two instances, and the queue and its per-connection lock live in one process.
A sync therefore also claims a lease on the connection row: `sync_lease_until` set to ten minutes
ahead with one conditional `UPDATE`, released when the run ends. A run that finds the lease taken
returns `busy` and retries after 30 s without counting an attempt. A purge waits up to 30 s for the
lease, then goes ahead without it and logs `calendar_sync.purge_without_lease`, because a user's
request is waiting on it. A run reads the connection again after claiming the lease, since the other
instance may have rotated the tokens.

## What the web sees

Every config response carries `target`, or `null` when direct sync is off for it: `provider`,
`status`, `capability`, `timeZone`, `lastSyncedAt`, `lastError` and `syncing`.

- `status` is `NEEDS_RECONNECT` when the connection is broken, else `PAUSED` without a plan, else
  `ACTIVE`.
- `syncing` is `ACTIVE` with `syncDueAt` set. After the queue gives up, `syncDueAt` stays set, so
  `syncing` is true next to a non-null `lastError`. Show the error then, not a spinner.
- `lastError` is `plan`, `auth_revoked`, `throttled`, `error` for an unexpected exception in the
  engine, or the driver's reason: a provider error code or `http_<status>`, such as `http_500`,
  `forbidden` or `ErrorAccessDenied`. A reason never carries a provider message.

## The ledger

`calendar_sync_events` holds one row per target and source record, unique on the config and
`source_key`: `v:<vacationId>` for a day row, `bd:<userId>` for a birthday, `ge:<groupEventId>`
for a group event, and a `:<n>` segment for a source that writes several events. Each
row also carries the source's own column (`vacation_id`, `group_event_id`, `birthday_user_id`), the
provider's event id, the kind (`ABSENCE`, `HOME_OFFICE`, `GROUP_EVENT` or `BIRTHDAY`), Google's
`eventType` and a content hash. The hash is SHA-256 over the
event's canonical JSON. The Microsoft hash leaves out `transactionId`, so it does not depend on the
ledger id. A sync is a diff against these rows, and a rerun of a finished sync makes no provider call.

- **New row.** The engine writes the ledger row first, then inserts, then stores the provider id. A
  row with no provider id is an insert that never confirmed, and the next run retries it under the
  same id.
- **Changed hash.** Microsoft patches, except a recurring group event, which is deleted and
  inserted again with its skipped dates cancelled. Its hash covers the skipped dates. Google patches when the stored `eventType` stays the same and
  otherwise deletes and inserts again under a new ledger id, because Google refuses to change an
  event's type. A missing stored type counts as a change.
- **Gone at the provider.** A patch that answers `not_found` inserts again under a new ledger id.
- **Left the set.** A row whose record was cancelled, rejected after approval, retyped out of the
  config or deleted is deleted at the provider and dropped. The engine matches by `source_key`,
  which outlives the source: a hard-deleted vacation sets the row's `vacation_id` to null, and the
  row still leaves the set.

Migration `0028_calendar_sync_sources.sql` keyed every existing row `v:<vacationId>`. A row whose
vacation had already been hard-deleted had no vacation id left, so it got `orphan:<ledgerId>`
instead. That key only keeps the row unique; it matches no source, so the next sync of that target
deletes the event at the provider and drops the row. No code writes the prefix after the migration.

## Local development

`CALENDAR_SYNC_DRIVER=fake` swaps both providers for fakes that never call out. Boot refuses it
when `NODE_ENV=production`. A provider's switch still has to be on, with any non-empty
`GOOGLE_CLIENT_ID`/`_SECRET` or `MICROSOFT_CLIENT_ID`/`_SECRET`.

- The fake consent URL points straight back at our own callback with `code=fake-code`, so following
  the URL from `start` completes the round.
- Tokens derive from the code: `fake-access-<provider>-<code>` and `fake-refresh-<provider>-<code>`.
- A code containing `fake-fail` fails the exchange, and one containing `fake-noscope` comes back
  without the calendar scope.
- A code containing `fake-revoked` yields a connection whose first refresh fails with
  `invalid_grant`.
- A code containing `fake-plain` yields an account the fake driver refuses status types for, like
  personal Gmail. The marker survives a refresh.
- The fake driver records every call in `calendar_sync_fake_events`: operation, provider event id,
  payload and result, `ok` or the failure. An event is live when it has an `ok` insert and no `ok`
  delete. Unit tests use `memoryFakeStore()` instead.
- `calendar_sync_fake_events` rows cascade with their connection row. After a disconnect the dump
  shows neither the inserts nor the deletes the purge sent.

Three dev routes sit behind the same five gates as the rest of `/api/dev`:

| Route                               | Body or query                                                            | Does                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/dev/calendar/connect`    | `email`, `provider` (`google`), `configId`, `timeZone` (`Europe/Prague`) | Connects a seeded user to the fake provider with no consent round, through the same store step as the callback. Without `configId` it reuses the config this connection already feeds, or creates a `ME` config with every record type. Refused (409) unless the driver is fake. |
| `GET /api/dev/calendar/events`      | `email`, optional                                                        | The fake driver's calls and the ledger rows, newest first, for one user or for everyone, up to 500 of each.                                                                                                                                                                      |
| `POST /api/dev/calendar/capability` | `email`, `provider` when the user has two connections, `capability`      | Sets the connection to `PLAIN`, `STATUS` or `UNKNOWN` and marks its targets due, so the next sync rebuilds every event.                                                                                                                                                          |

`connect` answers 201 with `connectionId`, `provider`, `configId`, `configCreated`, `timeZone` and
`entitled`. It does not grant a plan, so a Free user's target pauses, which is how to see the
`PAUSED` card. `capability` answers 200 with `connectionId`, `provider`, `capability` and
`targetsMarked`. `connect` and `capability` take `@dev.local` addresses only, like the other dev
writes, so `npm run dev:reset` undoes them.

`npm run dev:scenario` connects `owner@dev.local` to a fake Google target when the backend runs the
fake driver with Google on, and skips the step otherwise. The step gives the owner's organization a
Pro override first when no paid plan covers them. The scenario response carries the connection as
`calendar`, or `null`. Approving the owner's pending booking then leaves an insert that
`GET /api/dev/calendar/events?email=owner@dev.local` returns.

The `flexi-dev` MCP server wraps the three routes as `dev_calendar_connect`, `dev_calendar_events`
and `dev_calendar_capability`, and the workspace root runs them as
`npm run dev:calendar:connect|events|capability`. The `ui-test` loop uses those.

## Portal prerequisites

- **Google Cloud project `456983325414`.** The Calendar API is enabled. The sign-in web client lists
  `http://localhost:8080/api/calendar-sync/connections/google/callback` and
  `https://api.flexi-day.com/api/calendar-sync/connections/google/callback` among its redirect URIs.
  Data Access declares `https://www.googleapis.com/auth/calendar.events.owned` as a sensitive scope.
  The app is External and In production. Done in OPS-1 (T-297).
- **Entra registration "Flexi Day".** Multitenant plus personal accounts. The Web platform lists
  `http://localhost:8080/api/calendar-sync/connections/microsoft/callback` and
  `https://api.flexi-day.com/api/calendar-sync/connections/microsoft/callback`. Delegated Graph
  permissions `Calendars.ReadWrite` and `offline_access` are listed. Done in OPS-2 (T-298).
- **Switches.** `CALENDAR_SYNC_GOOGLE_ENABLED` and `CALENDAR_SYNC_MICROSOFT_ENABLED` count only as
  the literal `true`, and only while that provider's sign-in credentials are set, because a
  connection reuses the sign-in client. With both off, `config.calendarSync` is undefined, the
  callback route is not mounted, `start` answers 404 for both providers and the web hides the
  buttons. In production they come from the Terraform
  variables `calendar_sync_google_enabled` and `calendar_sync_microsoft_enabled`, see
  [`terraform.md`](terraform.md#calendar-direct-sync-switches) for the rollout order.

## Verification gates

**Google (T-302).** Until Google verifies the OAuth app for `calendar.events.owned`, every user sees
the "Google hasn't verified this app" screen, and the project may hand the scope to 100 users for
life. Every account that consents before verification uses one of the 100, and the count never
resets. Brand verification is already done. The scope submission needs an unlisted demo video of
the consent screen and the feature, so it waits for the web feature to reach production.

**Microsoft (T-301).** Until the publisher is verified, Entra's risk-based step-up consent
(`AADSTS90094`) stops users in other companies' tenants from granting `Calendars.ReadWrite`, so the
production Microsoft switch stays off. Verification may not be enough on its own: under Microsoft's
default consent policy a member could not consent to `Calendars.ReadWrite` even in our own tenant,
so many business customers will need their IT admin to grant tenant-wide consent once. After that,
staff connect without a consent screen. Personal Outlook.com accounts consent without either.

## The Testing-mode trap

Never move the Google app back to Testing. In Testing, Google expires every refresh token after
seven days, so each connection breaks a week after it was made and the card asks to reconnect, and
only 100 named test users may consent. The app is In production and unverified, which carries the
lifetime cap above but keeps refresh tokens alive.

## Known limitations

- A full-day absence on Google Workspace is a working-location chip. Working-location events are
  transparent by Google's rule, so the day stays free in "find a time" and free/busy. Visibility won
  over blocking.
- The chip row and Out of office need Workspace Business Standard or higher. Business Starter and
  personal Gmail get plain Busy events and no Home office.
- Google refuses an all-day Out of office through the API, so the top-row Out of office banner its
  own UI makes is out of reach.
- Microsoft shows no Home office. Its work-location API sets only the current day.
- Entra refresh tokens lapse after 90 idle days, and the card asks to reconnect.
- The Google app is unverified until T-302, with the interstitial and the 100-user lifetime cap.
- A broken connection sends no email. The card is the only signal.
- Teammates' records are never written, by design. That covers their birthdays: a shared birthday
  reaches team `.ics` feeds only. The one shared record a target carries is a group event of a
  group the owner is in.
- Group event times are floating: 10:00 is 10:00 for every viewer, and each output stamps its own
  zone, the target's here and the feed's own in `.ics`. A group spread across time zones sees the
  same wall clock, not the same instant.
- Subscribed `.ics` feeds refresh on the client's clock: Outlook.com every 3 to 24 hours, Google
  on an unstated schedule, Apple as the user sets it. Direct sync is the fast path.
- Monthly on day 29 or 30 goes into feeds and Google as `BYMONTHDAY=28,29,30;BYSETPOS=-1` (and
  `28,29` for day 29), pending the T-348 probe. If a client mishandles it, `monthlyDayRule` in
  `utils/ics.ts` switches to "on day 1 to 28" plus an explicit last day. Graph uses `absoluteMonthly` and needs no such form.
- A web day chip shows about eight characters of a group event's title; the popover has the rest.
- A colleague who leaves a group keeps their birthday in the phone store until the next snapshot.
  The read hides it.
- A feed or target reads at most 500 group events, the earliest first, so a group past that
  loses its furthest-ahead events from calendars until older ones age out of the window.
- No age leaves Flexi Day. A series has one title, so the year a birthday carries stays in the app.
- A purge that cannot delete an event leaves it. Each failed delete is retried three times, waiting
  the `Retry-After` up to 5 s. A row whose delete still fails stays in the ledger and its event
  stays in the user's calendar. The target is cleared anyway, so turning it off or disconnecting
  always completes, and the backend logs `calendar_sync.purge_incomplete` with the count. Without a
  usable token, a provider switched off included, the purge skips the provider entirely and logs
  `calendar_sync.purge_local_only`. Every event it wrote stays in the user's calendar.
- No probe has yet sent `extendedProperties.private` on a working-location event. The first live
  Google sync must confirm Google accepts it. If Google refuses, drop it from the custom-location
  and home-office payloads in `eventBuilder.ts` and keep it on `outOfOffice` and `default` events.
- The `.ics` feed builds each zone's `VTIMEZONE` from the current UTC year's transitions and trusts
  a weekday rule only if it also predicts the next two years. Past occurrences in a zone whose rules
  have changed since can come out shifted by the difference. A zone whose transitions fit no weekday
  rule, `Africa/Casablanca` among them, gets that year's fixed offsets with no `RRULE`, so next
  year's occurrences take this year's final offset. `Asia/Jerusalem` gets a `4FR` rule for the
  start of daylight saving, which is wrong in some years.

## Research

- [Google Calendar API](https://github.com/Daniel88dev/flexi-day-be/blob/research/google-calendar-api/docs/research/google-calendar-api.md)
- [Microsoft Graph calendar](https://github.com/Daniel88dev/flexi-day-be/blob/research/microsoft-graph-calendar/docs/research/microsoft-graph-calendar.md)
- [Apple calendar access](https://github.com/Daniel88dev/flexi-day-be/blob/research/apple-calendar-access/docs/research/apple-calendar-access.md),
  which explains why Apple is out
