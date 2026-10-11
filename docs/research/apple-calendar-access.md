# Apple calendar access: server-side routes and the on-device path

Research for T-284, checked on 2026-10-11. The parent map (T-281) covers direct calendar sync for
Google and Microsoft. The standing decision is that Apple stays out of scope for server-side sync
unless a password-free, OAuth-like server-side route into a user's iCloud calendar exists. This
file checks that against Apple's own documentation and confirms the on-device route for the iPhone
app.

Every claim carries its source and the date it was read. "Apple documents" means the fact is on
developer.apple.com or support.apple.com. "Third parties report" means it comes from vendor guides
or community reverse engineering and Apple publishes nothing that confirms it.

## Resolution

Apple stays out of scope for server-side sync. The only server-side path Apple acknowledges for
third-party apps is CalDAV against iCloud with an app-specific password, which is already ruled
out: the user has to mint a credential by hand, the credential is not scoped to calendars, it dies
whenever the user changes their Apple Account password, and Apple documents neither the server
address nor the protocol surface. A password-free alternative does exist in principle: since
October 2025 Apple lets "supported third-party apps" authorise iCloud Mail, Calendar and Contacts
access with an Apple Account sign-in, and Apple Developer Technical Support points developers to a
private "express interest in OAuth 2.0 for iCloud Mail, Calendar, and Contacts" form. That
programme has no public documentation, no published scopes or endpoints, no eligibility criteria
and no timeline, so it cannot be built against. Sign in with Apple, CloudKit and the App Store
Connect API grant no calendar access at all. The iPhone app is the Apple route: EventKit, through
`expo-calendar` in Expo SDK 57, writes to the user's calendars with their consent, and a save syncs
to whichever account (iCloud, Google, Exchange) the calendar belongs to.

## 1. Does any Apple API grant server-side access to a user's iCloud Calendar?

No. Each candidate below is documented as something else.

### Sign in with Apple

Apple describes the REST API as a way to "generate and validate the identity tokens used to verify
a user's identity" and nothing more. Its endpoints are `/auth/authorize`, `/auth/token`,
`/auth/revoke` and `/auth/keys`; the topic list carries no data endpoint. The `scope` parameter on
`/auth/authorize` accepts exactly two values, `name` and `email`, and the native
`ASAuthorization.Scope` type has the same two members, `email` and `fullName`. The access and
refresh tokens the token endpoint returns are usable only against those authentication endpoints.

- https://developer.apple.com/documentation/signinwithapplerestapi (read 2026-10-11)
- https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server (read 2026-10-11)
- https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens (read 2026-10-11)
- https://developer.apple.com/documentation/authenticationservices/asauthorization/scope (read 2026-10-11)

### CloudKit and CloudKit Web Services

CloudKit stores "structured app and user data in iCloud containers that all users of your app can
share". CloudKit JS gives "access from your web app to your CloudKit app's containers and
databases", and a server-to-server key reaches only "the public database from a server process or
script as an administrator". The containers are the developer's own; the user's Calendar database
is not a CloudKit container and no CloudKit API lists it. Calendar data is a separate framework,
EventKit, which runs on the device.

- https://developer.apple.com/documentation/cloudkit (read 2026-10-11)
- https://developer.apple.com/documentation/cloudkitjs (read 2026-10-11)

### App Store Connect API

The App Store Connect API "enables the automation of actions you take in App Store Connect":
in-app purchases, TestFlight, Xcode Cloud, provisioning, reporting, users and access. No user data
of any kind.

- https://developer.apple.com/documentation/appstoreconnectapi (read 2026-10-11)

### Recent WWDCs

The newest EventKit material Apple publishes is the WWDC23 session "Discover Calendar and
EventKit" (10052), which introduced the write-only access level described in section 3. Searches
for a WWDC24, WWDC25 or WWDC26 announcement of an iCloud Calendar web API or a new EventKit surface
turned up nothing on developer.apple.com. Absence of a search hit is weaker evidence than a
documented statement, but it matches the state of the API reference.

- https://developer.apple.com/videos/play/wwdc2023/10052 (searched 2026-10-11)

### The one real lead: Apple Account authorisation for "supported" apps

Apple published a support article on 2025-10-07 stating that "you can access your iCloud Mail,
Calendar, and Contacts in supported third-party apps across your devices after you authorize the
app using your Apple Account". The user enters their Apple Account email in the app, clicks Allow,
and can later revoke the grant under Sign-In and Security, Account Data Sharing at
account.apple.com. "If an app doesn't support this, you can sign in using an app-specific password
instead."

This is the password-free, OAuth-like route the decision was conditioned on. It is not available to
build against:

- Apple publishes no developer documentation for it: no scopes, no endpoints, no token format, no
  statement of which protocol (CalDAV with a bearer token, or something else) the grant unlocks.
- A developer asked exactly this on the Apple Developer Forums in May 2026 (what makes an app
  "supported", how to apply, what the mechanics are). The accepted answer, from Apple DTS, is a
  single link: "Express interest in Auth 2.0 for iCloud Mail, Calendar, and Contacts" at
  https://developer.apple.com/contact/request/icloud-oauth2/. That page redirects to an Apple
  Developer sign-in; it is an interest form, not a programme page, and the reply states no
  criteria or timeline.

Worth a one-off: submit the interest form from the Apple Developer account so Flexi Day is on the
list if the programme opens. It costs nothing and does not change the scope decision.

- https://support.apple.com/en-us/121539 (published 2025-10-07, read 2026-10-11)
- https://developer.apple.com/forums/thread/825772 (May 2026, read 2026-10-11)

## 2. Is CalDAV with an app-specific password still the only server-side path?

Yes, for any app that is not in Apple's private "supported" list.

### What Apple documents

App-specific passwords exist so that "apps made by developers other than Apple" can "access
information like mail, contacts, and calendars that you store in iCloud" without holding the main
password. The account must have two-factor authentication on. A user can hold at most 25 active
app-specific passwords. Changing or resetting the Apple Account password revokes every
app-specific password. Apple documents no per-service scoping: a password made for a calendar app
is the same credential that reaches iCloud Mail and Contacts.

Apple's support site publishes server settings for iCloud Mail (IMAP and SMTP hosts) and nothing
equivalent for iCloud Calendar. The only CalDAV material on Apple domains is the generic MDM
Calendar payload (`com.apple.caldav.account`) for "connecting to a CalDAV-compliant calendar
server", which takes a hostname and principal URL the administrator supplies.

Apple's stated position on third-party CalDAV clients therefore amounts to: they are tolerated
through app-specific passwords, which is the documented fallback for apps outside the
Apple Account authorisation programme. The protocol surface itself is not documented, versioned or
supported.

- https://support.apple.com/en-us/102654 (published 2025-10-08, read 2026-10-11)
- https://support.apple.com/en-us/102525 (read 2026-10-11; Mail only)
- https://support.apple.com/guide/deployment/depd57d3a18/web (read 2026-10-11)
- https://developer.apple.com/documentation/devicemanagement/caldav (read 2026-10-11)

### What third parties report

The hostname `caldav.icloud.com`, port 443, principal discovery via `PROPFIND` on `/` with
`current-user-principal`, and the partition-specific redirects (`pXX-caldav.icloud.com`) all come
from vendor guides (Nylas, OneCal) and community write-ups. A 2022 forum thread asking Apple for
official API documentation for exactly this server-side use case never received a reply from Apple.
Treat every such detail as reverse-engineered: it works today and can change without notice.

- https://cli.nylas.com/guides/icloud-caldav-settings (third party, read 2026-10-11)
- https://developer.nylas.com/docs/cookbook/calendar/apple-calendar-api/ (third party, read 2026-10-11)
- https://developer.apple.com/forums/thread/714336 (Sep 2022, no Apple reply, read 2026-10-11)

### Why this path stays ruled out

- Onboarding is manual: the user generates a password at account.apple.com and pastes it into
  Flexi Day. There is no consent screen and no redirect.
- The stored credential is a password, not a revocable scoped token, and it unlocks Mail and
  Contacts as well as Calendar.
- It breaks silently whenever the user changes their Apple Account password, which makes the sync
  rot in the background.
- Apple documents none of the endpoint behaviour, so there is nothing to build against and nothing
  to hold Apple to.

## 3. Can the iPhone app write to the user's calendars through EventKit and `expo-calendar`?

Yes, with user consent, and this remains the natural Apple route for later.

### EventKit (Apple)

EventKit lets apps "create, view, and edit calendar and reminder events". Access is gated: "your
app must obtain permission from the person using the app before it can access the calendar
database: your app must never directly modify the calendar database on its own." Since iOS 17
there are two levels and no read-only level:

- `requestWriteOnlyAccessToEvents()` (iOS 17, macOS 14, watchOS 10, visionOS 1): the app "can
  create events, but it can't access any of the existing calendars and events on the device,
  including events your app created".
- `requestFullAccessToEvents()` (same versions): read and write, including fetching, editing and
  deleting events.
- `requestAccess(to:completion:)` is deprecated from iOS 17.

Each level has its own Info.plist key, `NSCalendarsWriteOnlyAccessUsageDescription` or
`NSCalendarsFullAccessUsageDescription`, "required if your app uses APIs that write to the
person's calendar data". An app that only presents `EKEventEditViewController` needs no
permission at all on iOS 17 and later.

Two facts matter for the sync design. First, saving or removing an event "automatically syncs your
changes with the calendar the event belongs to (CalDAV, Exchange, and so on)", so an event the app
writes into an iCloud calendar reaches the user's other devices and iCloud.com through the
device's own account, with no server credential. Second, write-only access cannot read back
or delete the events it created, so a booking that gets cancelled or moved needs full access to
remove or update its calendar event; write-only suffices only for fire-and-forget creation.

Apple also states that an app "must get confirmation from the user before" modifying the Calendar
database, so writes should follow an explicit user action, not a background sync.

- https://developer.apple.com/documentation/eventkit (read 2026-10-11)
- https://developer.apple.com/documentation/eventkit/accessing-the-event-store (read 2026-10-11)
- https://developer.apple.com/documentation/eventkit/creating-events-and-reminders (read 2026-10-11)
- https://developer.apple.com/documentation/eventkit/ekeventstore/requestwriteonlyaccesstoevents(completion:) (read 2026-10-11)
- https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoevents(completion:) (read 2026-10-11)
- https://developer.apple.com/documentation/eventkit/ekeventstore/requestaccess(to:completion:) (read 2026-10-11)
- https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarswriteonlyaccessusagedescription (read 2026-10-11)
- https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsfullaccessusagedescription (read 2026-10-11)

### `expo-calendar` (Expo SDK 57)

The Expo wrapper exposes the same model. `flexi-day-rn` does not depend on it yet.

- Permissions: `Calendar.requestCalendarPermissions(writeOnly?)` and the
  `useCalendarPermissions({ writeOnly })` hook. `writeOnly` "allows creating calendar events
  without reading existing calendars or events" and "does not grant permission to create, update,
  or delete calendars". `requestCalendarPermissionsAsync()` is the deprecated name.
- Config plugin: `calendarPermission` sets `NSCalendarsUsageDescription` and
  `NSCalendarsFullAccessUsageDescription`; `writeOnlyAccess: true` with
  `writeOnlyCalendarPermission` "sets `NSCalendarsWriteOnlyAccessUsageDescription` and omits
  `NSCalendarsFullAccessUsageDescription`". Changing the plugin means a new native build.
- Writing: `calendar.createEvent(details)` creates an event in a given calendar;
  `calendar.addEventWithForm(options)` presents the system event dialog pre-filled, needing at
  least write-only permission; `Calendar.createCalendar(details)` creates a calendar of the app's
  own on the device. The `*Async` names are deprecated aliases.
- Runtime: "`expo-calendar` is currently unsupported in Expo Go and Snack." `flexi-day-rn` already
  runs as a dev client, so this costs nothing. The compatibility table lists Android and iOS as
  "device only"; the simulator has a Calendar app and EventKit, so expect the `ui-test` loop to
  need a check on a device before relying on it.

- https://docs.expo.dev/versions/v57.0.0/sdk/calendar/ (read 2026-10-11)

## What this means for the map

- Server-side calendar sync covers Google and Microsoft only. Apple users get no server-side
  option and the settings UI should say so rather than offer a CalDAV password field.
- The Apple route is an iPhone-app feature: on booking approval (or on a user tap), the app writes
  the event through `expo-calendar` into a calendar the user picks, and needs full access if it is
  to remove the event on cancellation.
- Submit Apple's OAuth 2.0 interest form once from the developer account and leave it there; revisit
  only if Apple publishes developer documentation for the programme.
