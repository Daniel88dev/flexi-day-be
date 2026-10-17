# Recurring and timed events in the ICS feed, Google Calendar and Microsoft Graph

Researched 2026-10-17 for fenro T-337 (map T-335, custom calendar events and birthdays) against
RFC 5545, RFC 7529 and RFC 7986, Google's Calendar API reference and guides, the Microsoft Graph
reference, Microsoft's Open Specifications for Outlook's iCalendar handling (MS-OXCICAL,
MS-STANOICAL, MS-OXOCAL), the Microsoft and Apple help centres, and the current `flexi-day-be` code.
Bracketed numbers point to the Sources list.

Settled context from the map: a group event belongs to one group, is all-day or timed, spans one day
or consecutive days, and may repeat (how often, and a last date). A birthday is a yearly all-day
event, month and day with an optional year, and 29 February shows on 28 February in non-leap years.

## Answer

Encode a recurring group event as **one series on every surface**: an `RRULE` in the feed, the
`recurrence` array on Google, `patternedRecurrence` on Microsoft. Every surface documents the simple
rule set a "repeat every N days/weeks/months/years until a date" form produces, and a series needs no
expansion horizon, so nothing has to roll a window forward.

- **Timed events carry the event's own IANA zone.** In the feed: `DTSTART;TZID=Europe/Prague:...`
  plus a `VTIMEZONE` block for that zone, which RFC 5545 and Outlook both require. A UTC start would
  drift by an hour across daylight saving on a recurring event. On Google and Microsoft: local
  `dateTime` plus `timeZone`, which Google requires on recurring events. The zone belongs to the
  event, not to the sync target, unlike today's timed absences.
- **Birthdays** are a yearly all-day series, `RRULE:FREQ=YEARLY`. For 29 February use
  `RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1` (the last day of February). Google prescribes exactly
  this rule for its own 29 February birthdays [6], and Outlook's import maps `BYMONTHDAY=-1` to its
  "day 31" pattern, which lands on the month's last day [13]. On Microsoft Graph,
  `absoluteYearly` with `month: 2, dayOfMonth: 29` should land on 28 February under Exchange's
  end-of-month rule [13][14], but Graph's own docs say nothing, so it needs one probe.
- **Exceptions.** Keep them to two shapes: a skipped occurrence (`EXDATE`) and a split series ("this
  and following"). Model an edited single occurrence as an `EXDATE` plus a standalone one-off event,
  never as a `RECURRENCE-ID` override. That keeps Google on plain insert, patch and delete. Microsoft
  has no `EXDATE`, so a skipped date means looking up the occurrence and deleting it, the one new
  driver operation.
- **Expansion horizon.** With series there is none. If a surface were expanded instead, the feed
  could expand per request at no state cost, but direct sync would need a trigger to extend the
  horizon: the sync queue runs only on change, at boot and on Sync now, so it would take a nightly
  job marking targets due.

Cost against today's code: `ics.ts` gains date-time values with `TZID`, `VTIMEZONE`, `RRULE` and
`EXDATE`. The ledger `calendar_sync_events` stops being keyed only on `vacationId`: it needs a
source per row (group event, birthday, vacation), two new `kind` values, and on Microsoft a record of
which dates it has already cancelled. The engine's diff, hash and insert/patch/delete paths stay as
they are.

## 1. What each surface documents

### RFC 5545 (the feed)

- **Series.** The recurrence set is built from `DTSTART` plus `RRULE`, `RDATE` and `EXDATE`;
  `DTSTART` is the first instance and "SHOULD match the pattern of the recurrence rule" [1, 3.8.5.1].
  `RRULE` "SHOULD NOT occur more than once in a component" [1, A.1].
- **Invalid dates are dropped.** Instances "with an invalid date (e.g., February 30) or nonexistent
  local time ... MUST be ignored and MUST NOT be counted" [1, 3.3.10]. So `FREQ=YEARLY` from 29
  February appears only in leap years, and `FREQ=MONTHLY` on the 31st skips short months.
- **Negative days.** `BYMONTHDAY` takes 1 to 31 or -31 to -1, "-10 represents the tenth to the last
  day of the month" [1, 3.3.10]. `BYMONTH=2;BYMONTHDAY=-1` is therefore 28 or 29 February.
- **RFC 7529 `SKIP=BACKWARD`** moves an invalid date to the previous valid day, and its own rationale
  names the leap-day birthday [2, 4.1]. It requires `RSCALE` in the rule, and Outlook ignores rule
  parts it does not know (section 3), so it is not a portable answer.
- **All-day.** Anniversaries use a `DATE` `DTSTART`, a `DATE` `DTEND`, and the RFC's own example is a
  yearly anniversary with `RRULE:FREQ=YEARLY` and `TRANSP:TRANSPARENT` [1, 3.6.1]. `BYHOUR`,
  `BYMINUTE` and `BYSECOND` must not appear when `DTSTART` is a `DATE` [1, A.1].
- **`UNTIL`** must have the same value type as `DTSTART`. With a `TZID` start it must be UTC
  [1, 3.3.10]. `EXDATE` may be `DATE` or `DATE-TIME` and may carry a `TZID` [1, 3.8.5.1].
- **Time zones.** Three forms: floating, UTC (`Z`, never with `TZID`), and local with `TZID`
  [1, 3.3.5]. "An individual VTIMEZONE calendar component MUST be specified for each unique TZID
  parameter value", and for a recurring component it "MUST provide valid time zone information for
  all recurrence instances" [1, 3.2.19, 3.6.5].
- **Overrides.** `RECURRENCE-ID`, with the same `UID`, names one instance by its original start;
  `RANGE=THISANDFUTURE` is the only range value [1, 3.8.4.4].
- **Refresh hint.** RFC 7986 adds `REFRESH-INTERVAL`, "a suggested minimum interval for polling"
  [3, 5.7]. No client below documents honouring it.

### Google Calendar API (direct sync)

- `recurrence[]` is a "List of RRULE, EXRULE, RDATE and EXDATE lines", and "DTSTART and DTEND lines
  are not allowed in this field" [4].
- `start.timeZone`: "For recurring events this field is required and specifies the time zone in
  which the recurrence is expanded" [4]. Google's own birthday rules use date-only starts with a
  yearly rule [6], so the requirement evidently targets timed events; sending the zone on all-day
  series too costs nothing.
- Instances carry `recurringEventId` and `originalStartTime`. Editing one instance creates an
  exception, and Google warns against editing instances one by one to change the whole series [5].
  `events.instances` lists them and accepts `calendar.events.owned`, the scope the app already holds
  [7].
- **Birthday event type.** `eventType: "birthday"` is "A special all-day event with an annual
  recurrence" [4]. Creating one requires an all-day single day, `visibility: private`,
  `transparency: transparent`, `RRULE:FREQ=YEARLY`, and for 29 February
  `RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1`. Only `colorId`, `summary` and `reminders` are allowed
  besides; no description and no `extendedProperties` [6]. `eventType` cannot change after creation
  [4].
- Status events (out of office, working location) are irrelevant here: group events and birthdays
  are informational, so they are `default` events on every capability.

### Microsoft Graph (direct sync)

- `recurrence` is a `patternedRecurrence`: a `pattern` (`daily`, `weekly`, `absoluteMonthly`,
  `relativeMonthly`, `absoluteYearly`, `relativeYearly`, each with an `interval`) and a `range`
  (`endDate`, `noEnd`, `numbered`) [8][9][10].
- `range.startDate` "Must be the same value as the start property of the recurring event";
  `recurrenceTimeZone` is optional and defaults to the event's zone [10][11].
- `absoluteYearly` requires `dayOfMonth` and `month` [9]. Graph does not say what `dayOfMonth: 29`
  does in February of a non-leap year.
- `isAllDay` requires start and end at midnight in the same zone [8].
- A series master lists `instances` (occurrences and exceptions, not cancelled ones),
  `exceptionOccurrences` and `cancelledOccurrences` [8]. `GET /me/events/{id}/instances` takes a
  required `startDateTime` and `endDateTime` and returns occurrence ids [12].
- There is no `EXDATE` field. A skipped date is an occurrence deleted by its id.
- `transactionId` dedupes a repeated create and cannot change afterwards [8], which the engine
  already relies on.

### Outlook's iCalendar import (subscribed feeds in Outlook)

MS-STANOICAL says Outlook imports "only a subset of RECUR values", specified in MS-OXCICAL. If a rule
cannot be split into supported rules, "the entire VEVENT is ignored" [15]. The subset from
MS-OXCICAL 2.1.3.2 [13]:

- Templates: daily, weekly, monthly, monthly Nth, yearly, yearly Nth. Each `BY` part takes one value
  except `BYDAY` on weekly rules.
- `BYMONTHDAY` "MUST be -1, or an integer between 1 and 31". On import, -1 becomes day 31.
- Yearly `INTERVAL` goes up to 8 (Outlook 2003: 1 only). Daily to 999, weekly and monthly to 99.
- **End-of-month rule (2.1.3.2.3):** RFC 2445 skips months that lack day 29, 30 or 31, whereas
  Exchange "MUST occur on the last day of months that do not have a sufficient number of days".
  A yearly rule is a monthly rule with a 12-month period [14], so a plain `FREQ=YEARLY` from 29
  February lands on 28 February in Outlook but is skipped in RFC-conformant clients. The explicit
  `BYMONTHDAY=-1` gives the same answer everywhere.
- Recurring timed events: `DTSTART` "MUST be specified as a local time with a TZID parameter", and
  a `VTIMEZONE` "MUST be declared for each unique value of any TZID". Only the `STANDARD` component
  with the largest `DTSTART` is parsed, and exactly one is exported, so a `VTIMEZONE` with one
  `STANDARD` and one `DAYLIGHT` carrying yearly `BYDAY` rules is the shape Outlook reads [13].
- `EXDATE` is imported into deleted instance dates, time stripped, and needs an `RRULE` in the same
  `VEVENT`. A `VEVENT` with a `RECURRENCE-ID` and the same `UID` becomes an exception [13].

One user report on Microsoft Q&A says Outlook mishandles `BYMONTHDAY=-1` in emailed invites [17].
It contradicts the spec and concerns invites rather than subscriptions; the probe in section 6
settles it for the feed.

### Subscribing clients: refresh

- **Outlook.com:** "This update can take more than 24 hours, although updates should happen
  approximately every 3 hours"; Outlook on the web says every 6 hours [16].
- **Google Calendar:** the help page on adding a calendar by URL gives no refresh interval [18].
  Third-party guides put it at 12 to 24 hours; nothing from Google confirms a figure.
- **Apple Calendar:** the user picks the interval in the subscription's Auto-refresh menu [19].

None of the three documents its `RRULE` or `VTIMEZONE` support for subscribed feeds beyond the
Outlook specs above. Google's API parses `BYMONTHDAY=-1` (it prescribes it [6]); that its feed
importer shares the parser is an inference.

## 2. Series or expanded occurrences, per surface

| Surface       | Series                                                                                          | Expanded occurrences                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ICS feed      | Compact, renders forever in every client. Outlook needs rules inside its subset.                | Stateless, the feed is rebuilt per request, so any horizon rolls for free. Clients show N unrelated events; a long daily series is large. |
| Google        | One event per series. `EXDATE` lines are a patch of the master. No horizon.                     | Fits today's engine unchanged, one ledger row per occurrence. Needs a horizon and a trigger to extend it; many calls per target.          |
| Microsoft     | One event per series. Skipped dates need an instances lookup and a delete per date. No horizon. | Same as Google. Avoids the instances API.                                                                                                 |
| Birthday, all | One yearly series, forever.                                                                     | Unbounded, so it always needs a horizon.                                                                                                  |

Series win on every surface once exceptions stay simple. The deciding cost of expansion is the
horizon. `docs/calendar-direct-sync.md` states the sync queue has "no cron, no SQS and no worker",
and a target only syncs on a change, at boot or on Sync now, so an expanded horizon of H months goes
stale H months after a target last synced. The backend does run a nightly croner tick for its sweeps
(`src/jobs/`), and a horizon could ride it by marking due every target whose next unwritten
occurrence has entered the window. That is a polling sweep over every target, and it multiplies
provider events: a weekly event is 52 events a year per target, a weekday-daily one about 260, where
a series is one. Birthdays are open-ended, so they would always need it.

## 3. Recurrence vocabulary all three express

What T-336 picks should map one to one. These map cleanly:

| Rule                          | RRULE (feed, Google)                   | Graph                                       |
| ----------------------------- | -------------------------------------- | ------------------------------------------- |
| Every N days                  | `FREQ=DAILY;INTERVAL=N`                | `daily`, `interval: N`                      |
| Every N weeks on chosen days  | `FREQ=WEEKLY;INTERVAL=N;BYDAY=MO,WE`   | `weekly`, `daysOfWeek`, `firstDayOfWeek`    |
| Every N months on day D       | `FREQ=MONTHLY;INTERVAL=N;BYMONTHDAY=D` | `absoluteMonthly`, `dayOfMonth: D`          |
| Every N months, Nth weekday   | `FREQ=MONTHLY;BYDAY=2TH` (or `-1TH`)   | `relativeMonthly`, `index: second` / `last` |
| Every N years on a date       | `FREQ=YEARLY;INTERVAL=N` (N up to 8)   | `absoluteYearly`                            |
| Until a date / N times / ever | `UNTIL=` / `COUNT=` / none             | `endDate` / `numbered` / `noEnd`            |

Two traps:

- **Monthly on the 29th to 31st.** RFC clients (Google, Apple) skip short months; Outlook and Graph
  move to the last day [1][13]. Either allow only days 1 to 28 plus an explicit "last day" option
  (`BYMONTHDAY=-1`, Graph `dayOfMonth: 31` under the same end-of-month rule), or accept that the
  surfaces disagree.
- **Multi-day recurring events.** Each occurrence spans the event's length (`DTEND` minus
  `DTSTART`), which all three model. Rules that pick several days per period on top of a multi-day
  span are where clients diverge; keep multi-day events to one occurrence per period.

Graph cannot express several `BYDAY` positions in one monthly rule or `BYSETPOS` lists, and Outlook
drops a `VEVENT` it cannot split [15]. The table above stays inside both.

## 4. Encoding per surface

### ICS feed

```text
BEGIN:VTIMEZONE
TZID:Europe/Prague
BEGIN:DAYLIGHT
DTSTART:19700329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:ge-<groupEventId>@flexiday
DTSTART;TZID=Europe/Prague:20261020T090000
DTEND;TZID=Europe/Prague:20261020T100000
RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T070000Z
EXDATE;TZID=Europe/Prague:20261222T090000
SUMMARY:Team retro
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:bd-<userId>@flexiday
DTSTART;VALUE=DATE:20280229
DTEND;VALUE=DATE:20280301
RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1
SUMMARY:Anna's birthday
TRANSP:TRANSPARENT
END:VEVENT
```

- One `VTIMEZONE` per zone in use, one `STANDARD` and one `DAYLIGHT`, for Outlook. Node has no API
  that returns a zone's rules, so the serializer needs a source: a small vendored table for the
  zones the product sees, or transitions derived from `Intl` offsets. A zone without daylight saving
  gets a single `STANDARD`.
- `TZID` on single timed events too, not only on series: MS-OXCICAL says non-recurring timed events
  SHOULD be local with `TZID` [13], and one code path is simpler.
- `UNTIL` in UTC when `DTSTART` has a `TZID` [1]. All-day series use a `DATE` `UNTIL` and `DATE`
  `EXDATE`s.
- The birthday `DTSTART` must match its rule, so for 29 February pick a leap-year 29 February or a
  non-leap 28 February. Anchor it to something stable, such as the first occurrence on or after the
  day the birthday was saved, so it does not move every year.
- UIDs need a namespace per source: today's are `<vacationId>@flexiday`. On a `TEAM` feed a user in
  two selected groups must yield one birthday, not two.
- The 12-months-back window filters vacation rows by `requestedDay`. A series passes it when its end
  is on or after the window start, or it has no end.

### Google

- `eventType: "default"`, `transparency: "transparent"`, `reminders.useDefault: false`, the existing
  `extendedProperties.private` with a source id instead of `flexiDayVacationId`.
- Timed: `start: { dateTime: "2026-10-20T09:00:00", timeZone: "Europe/Prague" }`, same on `end`.
  All-day: `start.date`, `end.date` the day after the last day.
- `recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T070000Z", "EXDATE;TZID=Europe/Prague:20261222T090000"]`.
- Birthdays as `default` yearly events rather than the native `birthday` type: the native type
  forbids a description and `extendedProperties`, and no probe has shown it works under
  `calendar.events.owned` on every account type. Switching later is a type change, which the engine
  already handles as delete and insert.

### Microsoft

- `showAs: "free"`, `isReminderOn: false`, `transactionId` as today.
- Timed: local `dateTime` with `timeZone: "Europe/Prague"`. All-day: `isAllDay: true`, midnight to
  midnight in one zone.
- `recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["tuesday"], firstDayOfWeek: "monday" }, range: { type: "endDate", startDate: "2026-10-20", endDate: "2027-06-29" } }`.
- Skipped date: `GET /me/events/{seriesId}/instances` for that one day, then `DELETE` the occurrence
  id it returns.
- Birthday: `absoluteYearly`, `interval: 1`, `month`, `dayOfMonth`, `range.type: "noEnd"`. For 29
  February, `dayOfMonth: 29` pending the probe. If Graph refuses it or skips non-leap years, fall back
  to four series with `interval: 4`: one on 29 February from a leap year, three on 28 February from
  the three years after it.

## 5. Cost against the current code

**`src/utils/ics.ts`** writes `DATE` events only. Needed: an event union (all-day or timed with a
zone), `DTSTART;TZID=`, `VTIMEZONE` generation, `RRULE` and `EXDATE` lines, `UNTIL` conversion to
UTC. `handleGetCalendarFeed` maps more than vacation rows. The rest (escaping, folding) stays.

**`calendar_sync_events`** has a unique index on `(calendar_sync_id, vacation_id)`, and the engine's
`reconcile` builds `byVacation` from it:

- Add nullable `group_event_id` and a birthday source column, each a foreign key with
  `on delete set null` like `vacation_id`, so a hard delete still leaves a row the engine deletes at
  the provider. Unique indexes per source, or one `(calendar_sync_id, source_key)` index.
- Add `kind` values for group events and birthdays.
- A Microsoft series needs the set of dates already cancelled, so a later diff deletes only the new
  ones. A `cancelled_dates` column, or the rule "any change to the dates deletes and re-inserts the
  series, then cancels every date". The second is simpler and costs 2 plus 2 per date calls on an
  infrequent change.
- A 29 February birthday on the four-series fallback needs several rows per source, so the key needs
  a segment index.

**`eventBuilder.ts`**: new payload builders. `GoogleEventPayload` gains `recurrence`; the Microsoft
payload gains `recurrence` and `showAs: "free"`. The content hash covers the rule and the dates, so
the existing hash diff picks up every change.

**Drivers**: Google needs nothing new. Microsoft needs one operation, cancel occurrence by date.
`Calendars.ReadWrite` covers the instances read.

**`syncEngine.ts`**: `reconcile` keys by source instead of `vacationId`; `getFeedRecords` grows into
a union of vacation rows, group events and birthdays. The ledger-first insert, the `not_found`
re-insert and the Google type-change rule all carry over.

**Not affected**: capability probing, since group events and birthdays are `default` events; the
queue; dirty marking needs new callers (group event writes, birthday sharing changes), not a new
mechanism.

## 6. Open points and probes

- **Graph `absoluteYearly` on 29 February.** Create one on a test mailbox and list instances for a
  non-leap year. MS-OXCICAL and MS-OXOCAL predict 28 February [13][14].
- **Graph IANA zone on a recurring event.** OPS-2 (T-298) confirmed `Europe/Prague` on single
  events only.
- **Outlook subscribed feed with `BYMONTHDAY=-1` and a `TZID` series.** Subscribe Outlook.com to a
  dev feed; this also settles the Q&A report [17].
- **Google subscribed feed:** check a `TZID` series and the 29 February rule render as expected.
- **Age on birthdays.** The map says whoever sees a birthday with a year sees the age. A series has
  one `SUMMARY`, so the age cannot sit in the title on external calendars. Options: no age outside
  Flexi Day, the birth year in the description, or per-year events (which brings the horizon back).
  A spec decision.
- **Free or busy.** Group events are informational, so transparent and `free` is the proposed
  default. A timed group meeting might want to block time; also a spec decision.
- **Which zone a timed group event stores.** Creator's browser zone at creation, or the
  organization's attendance `timezone` when set (`organization_attendance_settings.timezone`). T-336
  or the data model decides.

## Sources

1. RFC 5545, Internet Calendaring and Scheduling Core Object Specification, sections 3.2.19, 3.3.5,
   3.3.10, 3.6.1, 3.6.5, 3.8.4.4, 3.8.5.1, A.1. https://www.rfc-editor.org/rfc/rfc5545
2. RFC 7529, Non-Gregorian Recurrence Rules in iCalendar, section 4.1.
   https://www.rfc-editor.org/rfc/rfc7529
3. RFC 7986, New Properties for iCalendar, section 5.7. https://www.rfc-editor.org/rfc/rfc7986
4. Google Calendar API, Events resource.
   https://developers.google.com/workspace/calendar/api/v3/reference/events
5. Google Calendar API, Recurring events guide.
   https://developers.google.com/workspace/calendar/api/guides/recurringevents
6. Google Calendar API, Event types guide (Birthday section).
   https://developers.google.com/workspace/calendar/api/guides/event-types
7. Google Calendar API, `events.instances`.
   https://developers.google.com/workspace/calendar/api/v3/reference/events/instances
8. Microsoft Graph v1.0, event resource type.
   https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0
9. Microsoft Graph v1.0, recurrencePattern resource type.
   https://learn.microsoft.com/en-us/graph/api/resources/recurrencepattern?view=graph-rest-1.0
10. Microsoft Graph v1.0, recurrenceRange resource type.
    https://learn.microsoft.com/en-us/graph/api/resources/recurrencerange?view=graph-rest-1.0
11. Microsoft Graph, Schedule repeating appointments as recurring events in Outlook.
    https://learn.microsoft.com/en-us/graph/outlook-schedule-recurring-events
12. Microsoft Graph v1.0, List instances.
    https://learn.microsoft.com/en-us/graph/api/event-list-instances?view=graph-rest-1.0
13. [MS-OXCICAL] iCalendar to Appointment Object Conversion Algorithm, revision 15.0 (2025-05-20),
    sections 2.1.3.1.1.19, 2.1.3.1.1.20.10, 2.1.3.1.1.20.13, 2.1.3.1.1.20.20, 2.1.3.2.1.2,
    2.1.3.2.1.5, 2.1.3.2.2.5, 2.1.3.2.3, product behavior notes 50, 266, 298.
    https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/a685a040-5b69-4c84-b084-795113fb4012
14. [MS-OXOCAL] Finding Valid Recurrence Dates.
    https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/181a11eb-0f26-4d8f-8292-8c77dcfb03e3
15. [MS-STANOICAL] RFC 5545 section 3.8.5.3 Recurrence Rule, notes V0193 to V0196.
    https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/626c9e29-4871-426e-997b-0df1342da1f2
16. Microsoft Support, Import or subscribe to a calendar in Outlook.com or Outlook on the web.
    https://support.microsoft.com/office/cff1429c-5af6-41ec-a5b4-74f2c278e98c
17. Microsoft Tech Community, "Outlook not parsing ics invites with RRULE BYMONTHDAY=-1 or
    BYSETPOS=-1 properly" (user report, not Microsoft documentation).
    https://techcommunity.microsoft.com/discussions/outlookgeneral/outlook-not-parsing-ics-invites-with-rrule-bymonthday-1-or-bysetpos-1-properly/4403885/replies/4407157
18. Google Calendar Help, Subscribe to someone's Google Calendar (adding a calendar from a URL).
    https://support.google.com/calendar/answer/37100
19. Apple Support, Subscribe to calendars on Mac.
    https://support.apple.com/en-au/guide/calendar/icl1022/mac
20. `flexi-day-be` at `origin/main` 4ead0c6: `src/utils/ics.ts`,
    `src/controllers/calendarSync/handleGetCalendarFeed.ts`,
    `src/services/calendarSync/{calendarSyncServices,syncEngine,eventBuilder}.ts`,
    `src/services/calendarSync/drivers/`, `src/db/schema/calendar-connection-schema.ts`, `src/jobs/`,
    `docs/calendar-direct-sync.md`.
