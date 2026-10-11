# Google Calendar API v3: what own-calendar sync can write, under which scopes, and what publishing costs

Researched 2026-10-11 for fenro T-282 against Google's Calendar API reference and guides, the Google
Auth Platform help centre, the Workspace Updates blog, and the npm registry. Bracketed numbers point
to the Sources list. The spec under test: one-way sync of a user's own approved absences into a
calendar they own (primary by default), absences shown as Out of office, Home office days as a
working location of Home rather than an event.

## Answer

Both status event types the spec wants are writable through `events.insert`, but only on the primary
calendar and only for accounts whose Workspace edition carries the feature. Google documents neither
for consumer Gmail accounts; nothing in the API reference says they are refused, and nothing says
they work, so the consumer path has to be settled by one call against a real Gmail account. Out of
office events must be timed, never all-day. Working location events are either timed or exactly one
all-day day, overlap freely and never replace each other, so the sync has to track its own event ids
and delete before re-creating. The three August scopes cover every call the spec makes; the Cloud
Console labels them sensitive, and no Calendar scope is restricted, so verification needs a demo
video and 3 to 5 business days, not a security assessment. Testing mode still caps at 100 test users
and expires refresh tokens after 7 days. `@googleapis/calendar` is at 20.1.0 and pulls
`google-auth-library` 11.x, which still refreshes exactly as the August design assumed; both now
require Node 22 or newer, which the repo's Node 24 pin satisfies.

## 1. Out of office

**Writable through `events.insert`.** The status-events guide says to create one by calling
`events.insert` with `eventType: 'outOfOffice'`, an `outOfOfficeProperties` object,
`transparency: 'opaque'`, and timed `start`/`end`; "Out of office events cannot be all-day events"
[1]. The Events reference lists `outOfOffice` among the `eventType` values and marks only
`fromGmail` as a type that "cannot be created"; `eventType` "cannot be modified after the event is
created" [2]. `events.insert` accepts `calendar.events.owned` [3]. Google announced create, update
and patch support for out of office events in November 2023 [8].

**Primary only.** "These features are only available on primary calendars, and to some Google
Calendar users." and "Secondary calendars can't have status events." [1]. So a user who points the
sync at a secondary calendar cannot get Out of office there at all.

**Account types.** Google scopes the feature by Workspace edition. The November 2023 post lists Out
of office as available to Workspace Essentials, Enterprise Essentials, Frontline, Enterprise
Starter and the Standard, Plus, Business, Nonprofit and Education tiers [8]. The Calendar help page
that documents the UI opens with "You can use working hours and availability if your account is
through your work or school organization." [9]. No Google page found says a personal Gmail account
can or cannot hold an `outOfOffice` event. The reference pages are silent on account type [2][3],
and the only improvement Google logged is that since June 2024 unsupported operations on "special
event types, such as working location, out-of-office, and focus time events" return clearer error
messages [7], which means a refusal, if one happens, will at least be legible.

**Consumer fallback.** For an account where the insert is refused, the fallback is a regular
`default` event with `transparency: 'opaque'`, which is the default and "corresponds to 'Busy' in
the UI" [2]. An all-day `default` event is allowed, so the fallback can be all-day while the real
Out of office must be timed. `outOfOfficeProperties.autoDeclineMode` (`declineNone`,
`declineAllConflictingInvitations`, `declineOnlyNewConflictingInvitations`) and `declineMessage`
exist only on the real thing [2]; the fallback declines nothing.

## 2. Working location

**Writable through `events.insert`.** Required fields: `eventType: 'workingLocation'`, a
`workingLocationProperties` object, `visibility: 'public'`, `transparency: 'transparent'` [1].
`workingLocationProperties.type` is "Required when adding working location properties" and takes
`homeOffice`, `officeLocation` or `customLocation`; `homeOffice` is an "any value" field whose
presence means the user is working at home [2]. Reading and writing working locations has been
generally available since August 2023 [7][10].

**Timing.** A working location event is either timed, or all-day spanning exactly one day:
"All-day working location events cannot span multiple days, but timed events can." [1]. One
Home office day in Flexi Day therefore maps to one all-day working location event per day.

**Primary only, Workspace only.** Same sentence as above: primary calendars, "some Google Calendar
users", secondary calendars cannot hold status events [1]. The GA announcement lists the feature as
available to Business Standard, Business Plus, Enterprise Standard, Enterprise Plus, the Education
editions, Teaching and Learning Upgrade, Nonprofits and legacy G Suite Business, and "Not available
to Google Workspace Essentials, Business Starter, Enterprise Essentials, Frontline, G Suite Basic
customers" [10]. Admins can switch it off per organisational unit on Business Plus, Enterprise
Standard and Plus, Education and Nonprofits; on Business Standard users have it and the admin
cannot turn it off; switching it off "deletes any already-existing locations" within up to 36 hours
[11]. Personal accounts are not mentioned anywhere [10][11].

**Add, never replace.** "A user can have multiple working location events on their calendar at the
same time which overlap." Google gives clients a precedence order for which one to display (timed
over all-day, single over recurring, later start, shorter, more recently created) and says
"Partially overlapping events should be shown as two different events each with their own working
location." [1]. Inserting a second Home for the same day therefore adds a duplicate rather than
replacing what is there. The sync has to store the Google event id it created and update or delete
that one; it cannot rely on the calendar to deduplicate.

**Update and delete.** `events.update` works as long as "the event must maintain the required
fields" [1]. Deletion is not special-cased: `events.delete` takes `calendarId` and `eventId` and
lists no `eventType` restriction [4]. One limit matters for bulk sync: "Creating and updating
working location events through the batch endpoints isn't supported." [1], so each day is its own
request. `events.list` filters with a repeatable `eventTypes` parameter (`workingLocation`,
`outOfOffice`, and the rest) [5], which lets a reconcile step read back only what the sync owns.

## 3. Scopes

Every call in the spec is covered by the three August scopes, each accepted alone:

| Call                                          | Scope the design holds           | Listed on the method                                                   |
| --------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `events.insert` (Out of office, working loc.) | `calendar.events.owned`          | yes, with `calendar`, `calendar.events`, `calendar.app.created` [3]    |
| `events.update` / `events.delete`             | `calendar.events.owned`          | yes, same four [4]                                                     |
| `events.list` (reconcile)                     | `calendar.events.owned`          | yes [5]                                                                |
| `calendarList.list` (destination picker)      | `calendar.calendarlist.readonly` | yes, with `calendar`, `calendar.readonly`, `calendar.calendarlist` [6] |
| `calendars.insert` (new secondary calendar)   | `calendar.calendars`             | yes, with `calendar`, `calendar.app.created` [12]                      |

Google describes `calendar.events.owned` as "See, create, change, and delete events on Google
calendars you own.", `calendar.calendarlist.readonly` as "See the list of Google calendars you're
subscribed to." and `calendar.calendars` as "See and change the properties of Google calendars you
have access to, and create secondary calendars." [13]. Nothing on the status-events guide or the
`eventType` field narrows which scope may write `outOfOffice` or `workingLocation`; the scope is
checked per method, not per event type [1][2][3].

Two consequences for the spec. First, `calendar.calendars` is wider than the name suggests: it also
lets the app change properties of calendars the user merely has access to. If creating a secondary
calendar stays in scope, `calendar.app.created` ("Make secondary Google calendars, and see, create,
change, and delete events on them." [13]) is the narrower alternative: it covers `calendars.insert`
[12], `events.insert` [3] and `events.delete` [4] on calendars the app itself created. It does not
help with the primary calendar, and status events do not work on secondary calendars anyway [1], so
a secondary-calendar destination only ever receives plain events. Second, dropping secondary
calendars from the spec drops `calendar.calendars` entirely and leaves two scopes.

**Sensitivity.** Google's Calendar auth page classifies nothing; it only says a public app using
"scopes that permit access to certain user data" must complete verification [13]. The sensitive
scope guide uses "reading Google Calendar events" as its example of a sensitive scope [14]. The
official restricted-scope list has sections for Gmail, Drive, Fit, Chat, Data Portability, Photos
Ambient and Google Health, and no `https://www.googleapis.com/auth/calendar...` entry [15]. So all
three (or two) scopes are sensitive, none is restricted, and the annual CASA security assessment
that restricted scopes carry [16] does not apply. The Cloud Console labels each scope when it is
added to the project [17], which is the place to confirm this before submitting.

## 4. Verification and publishing

**Testing mode.** An External project in Testing is "limited to up to 100 test users listed in the
OAuth consent screen", and "Authorizations by a test user will expire seven days from the time of
consent"; if the app "receives a refresh token, that token will also expire." Only the
name/email/profile scopes are exempt [18]. The OAuth 2.0 reference says the same from the token
side: a project with an external user type and Testing status gets refresh tokens that expire after
7 days [19]. Both August assumptions hold.

**In production without verification.** Moving to In production makes the app "available to any
user with a Google Account", but with sensitive scopes unverified "Google will display an Unverified
apps warning message", and the app may onboard "100 new users in total, after the app presents the
unverified app screen"; that cap "applies over the entire lifetime of the project, and it cannot be
reset or changed" [18]. So the 100-user ceiling exists in both states; verification is the only way
past it.

**What the submission needs** [20][21][14]:

- A homepage "hosted on a verified domain you own" that "must describe your app's functionality" and
  "can not be only a login page", linking the privacy policy.
- A privacy policy "hosted within the domain that hosts your homepage" and "linked from the OAuth
  consent screen"; it must describe how the app accesses, uses, stores or shares Google user data.
- Domain ownership of every authorised domain, proven in Google Search Console by a project owner or
  editor. `flexi-day.com` and `api.flexi-day.com` both need to be authorised domains if the consent
  screen or redirect URIs use them.
- Branding must already be verified ("You must have a published branding status before you can
  request verification for data access") [22]; brand review is automated in minutes or "usually
  takes 2-3 business days" when manual [23].
- A demo video that "Must show the end-to-end flow of your app including the OAuth grant process",
  the complete consent screen with "the same exact scopes you are requesting", in English, and
  "Must demonstrate the app functionalities that utilize the requested OAuth scopes" [20]. It is
  uploaded to YouTube as Unlisted [14].
- A per-scope justification with "An explanation why narrower scopes would not work" [20]; asking
  for more than the app needs is grounds for rejection [21].

**Turnaround.** "The sensitive scope verification process typically takes 3-5 business days to
complete." [14]. Restricted scopes "can potentially take several weeks" and add the assessment [16];
not applicable here. The submission flow is Publish App, Prepare for Verification, justify scopes,
link the video, Submit; "All communications with the OAuth review team will occur over email to the
project owners and project editors." [21].

## 5. Client libraries

**`@googleapis/calendar`** is at 20.1.0, published 2026-10-03, `engines.node >=22.0.0`, with
`googleapis-common ^9.0.0` as its only dependency [24]. The August design named v16; the jump is
Google's regenerated-client cadence, not an API change. `googleapis-common` 9.x depends on
`google-auth-library ^11.0.0` [25], so installing the calendar package resolves auth 11.x.

**`google-auth-library`** is at 11.2.0, published 2026-10-07, `engines.node >=22` [26]. The only
breaking change in 11.0.0 (2026-07-29) is the Node 22 floor [27]. The `google-auth-library-nodejs`
GitHub repository is archived; the source now lives at
`googleapis/google-cloud-node/core/packages/google-auth-library-nodejs` [28][29]. The refresh model
the August design relied on is unchanged: the README still says the library "will automatically
obtain an `access_token`, and automatically refresh the `access_token` if a `refresh_token` is
present", that the refresh token "is only returned on the first authorization", that the `tokens`
event is the way to persist a rotated token, and that `generateAuthUrl` needs `access_type:
'offline'` and `prompt: 'consent'` to force a new refresh token [29]. In the current `OAuth2Client`,
`isTokenExpiring()` compares `expiry_date` against now plus `eagerRefreshThresholdMillis`,
`getRequestMetadataAsync` refreshes when the token is missing or expiring, and
`forceRefreshOnFailure` retries once after a 401/403 when no `expiry_date` is known [30]. The
design's "60 s skew" is therefore `eagerRefreshThresholdMillis: 60_000` on the client, and the
encrypted write-back belongs in a `tokens` listener.

## What this means for the spec

1. **Out of office**: insert `eventType: 'outOfOffice'`, timed, `transparency: 'opaque'`, on
   `primary` only. Treat a refusal as "this account cannot hold status events" and fall back to a
   plain all-day `default` event with `transparency: 'opaque'`. Run one real insert against a
   personal Gmail account before fixing the fallback rule, since Google documents neither outcome.
2. **Working location**: insert one all-day `eventType: 'workingLocation'` event per Home office
   day with `workingLocationProperties: { type: 'homeOffice', homeOffice: {} }`,
   `visibility: 'public'`, `transparency: 'transparent'`, on `primary` only, one request each (no
   batch). Store the returned event id; re-sync updates or deletes that id, because a second insert
   adds a duplicate.
3. **Scopes**: keep `calendar.events.owned` and `calendar.calendarlist.readonly`. Keep
   `calendar.calendars` only if creating a secondary calendar stays in the spec, knowing status
   events cannot land there; otherwise drop it, or swap it for `calendar.app.created`. All sensitive,
   none restricted, no CASA.
4. **Verification**: budget a homepage and privacy policy on `flexi-day.com`, Search Console
   ownership, brand verification first, an unlisted English demo video and per-scope justifications;
   expect 3 to 5 business days after submission. Until then the ceiling is 100 users whether the app
   sits in Testing (7-day tokens) or unverified In production (lifetime cap plus a warning screen).
5. **Client**: `@googleapis/calendar@20.1.0` and `google-auth-library@11.2.0` on Node 24; the
   OAuth2Client refresh behaviour the design assumed is intact.

## Sources

All retrieved 2026-10-11.

1. Google, Calendar API guide, Manage focus time, out of office, and working location events.
   https://developers.google.com/workspace/calendar/api/guides/calendar-status
2. Google, Calendar API reference, Events resource.
   https://developers.google.com/workspace/calendar/api/v3/reference/events
3. Google, Calendar API reference, events.insert.
   https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
4. Google, Calendar API reference, events.delete.
   https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
5. Google, Calendar API reference, events.list.
   https://developers.google.com/workspace/calendar/api/v3/reference/events/list
6. Google, Calendar API reference, calendarList.list.
   https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
7. Google, Calendar API release notes (entries 2021-02-01, 2022-08-22, 2023-08-17, 2024-02-06,
   2024-02-07). https://developers.google.com/calendar/docs/release-notes
8. Google Workspace Updates, 2023-11-17, Calendar API: read and write out of office and focus time
   events.
   https://workspaceupdates.googleblog.com/2023/11/calendar-api-read-write-out-of-office-and-focus-time-events.html
9. Google Calendar Help, Set your working hours & location (includes "Show when you're out of
   office"). https://support.google.com/calendar/answer/7638168
10. Google Workspace Updates, 2023-08-16, Programmatically read and write working locations with the
    Calendar API, now generally available.
    https://workspaceupdates.googleblog.com/2023/08/calendar-api-working-location-read-write-generally-available.html
11. Google Workspace Admin Help, Turn working location on or off for users.
    https://knowledge.workspace.google.com/admin/calendar/turn-working-location-on-or-off-for-users
    (redirect target of https://support.google.com/a/answer/10918567)
12. Google, Calendar API reference, calendars.insert.
    https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
13. Google, Calendar API, Choose Google Calendar API scopes.
    https://developers.google.com/workspace/calendar/api/auth
14. Google, OAuth 2.0, Sensitive scope verification.
    https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
15. Google Auth Platform Help, Restricted scopes. https://support.google.com/cloud/answer/13464325
16. Google, OAuth 2.0, Restricted scope verification.
    https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
17. Google Auth Platform Help, OAuth app verification (overview).
    https://support.google.com/cloud/answer/13463073 and https://support.google.com/cloud/answer/9110914
18. Google Auth Platform Help, Manage App Audience (user type, publishing status, test users,
    unverified-app cap). https://support.google.com/cloud/answer/15549945
19. Google, Using OAuth 2.0 to Access Google APIs, Refresh token expiration.
    https://developers.google.com/identity/protocols/oauth2#expiration
20. Google Auth Platform Help, Verification requirements.
    https://support.google.com/cloud/answer/13464321
21. Google Auth Platform Help, Submitting your app for verification.
    https://support.google.com/cloud/answer/13461325
22. Google Auth Platform Help, Manage App Branding. https://support.google.com/cloud/answer/10311615
23. Google, OAuth 2.0, Brand verification.
    https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
24. npm registry, `@googleapis/calendar` 20.1.0 (`npm view @googleapis/calendar version time
engines dependencies`). https://www.npmjs.com/package/@googleapis/calendar
25. npm registry, `googleapis-common` 9.x dependencies (`npm view googleapis-common dependencies`).
    https://www.npmjs.com/package/googleapis-common
26. npm registry, `google-auth-library` 11.2.0 (`npm view google-auth-library version time
engines repository`). https://www.npmjs.com/package/google-auth-library
27. google-auth-library CHANGELOG, 11.0.0 (2026-07-29).
    https://github.com/googleapis/google-cloud-node/blob/main/core/packages/google-auth-library-nodejs/CHANGELOG.md
28. GitHub, googleapis/google-auth-library-nodejs (archived; README points to the new location).
    https://github.com/googleapis/google-auth-library-nodejs
29. google-auth-library README, OAuth2 section.
    https://github.com/googleapis/google-cloud-node/blob/main/core/packages/google-auth-library-nodejs/README.md
30. google-auth-library source, `OAuth2Client` (`isTokenExpiring`, `getRequestMetadataAsync`,
    `forceRefreshOnFailure`).
    https://github.com/googleapis/google-cloud-node/blob/main/core/packages/google-auth-library-nodejs/src/auth/oauth2client.ts
