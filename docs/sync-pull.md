# Sync pull

The rules behind the sync glossary rows in [`GLOSSARY.md`](../GLOSSARY.md). One endpoint,
`GET /api/sync/pull?cursor=`, feeds the phone app's local copy of what the caller can see on the
web. Why the cursor is an `updatedAt` high-water mark rather than a change log:
[ADR 0005](adr/0005-sync-pull-cursors-on-updated-at.md). The route's own facts, from the compression
to the limiters, are in [`invariants.md`](invariants.md#sync-pull-transport-srcroutessyncrouterts).

## Envelope

```json
{
  "cursor": "opaque",
  "hasMore": false,
  "reset": false,
  "first": true,
  "organizations": [],
  "users": [],
  "groups": [],
  "groupUsers": [],
  "groupMirrors": [],
  "userYearQuotas": [],
  "bankHolidays": [],
  "vacations": [],
  "groupEvents": [],
  "birthdays": []
}
```

The ten table keys are always present, in that dependency order, so a client can apply a page top
to bottom. They follow the Drizzle export names, pluralised where the schema's is singular (`users`
for `user`, `vacations` for `vacation`), with one exception: `birthdays` carries `userBirthdays`.
Rows are raw table rows: camelCase column names, timestamps ISO 8601 UTC, dates `YYYY-MM-DD`, no
joined summaries and no per-row verdicts. A vacation row of another person reaches the caller as the
web shows it to them, under [Private details](#private-details) below.

Every partitioned row carries `organizationId`: groups carry their own, `groupUsers`,
`userYearQuotas`, `vacations` and `groupEvents` their group's, `groupMirrors` the target group's. `users`,
`bankHolidays` and `birthdays` are unpartitioned and carry none: a birthday belongs to a person, not
to a group.

## Scope

Scope is membership-only, exactly the web dashboard and calendar, and comes from the report
service's membership scope (`getScopeEntries`), not the wider one the report reads
(`getReportScopeEntries`), which adds the groups the caller administers. One level per group drives
every table: `all` when the caller's membership row carries view or admin access or they are the
group's manager, `self` otherwise. A group the caller holds no live membership row in is absent
whatever else they are there, an org admin of the owning organization or the group's own manager. A
delta resolves the same scope with soft-deleted groups kept, which the report drops, so a group
soft-deleted before the window the delta covers still counts as one of the caller's while their
membership row lives.

| Table            | Seen in full (`all`)                                                                       | Self-scoped (`self`)  | Beyond those groups                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------- |
| `organizations`  | the organization of the group: `id`, `name` and `sickDayBenefitEnabled`                    | the same              | the organization of any other group the pull names                               |
| `users`          | every member and the manager                                                               | the caller            | every actor on a visible booking                                                 |
| `groups`         | the group row                                                                              | the group row         | a group the caller has left but still holds bookings in; a mirror's source group |
| `groupUsers`     | the full live member list                                                                  | the caller's own row  | nothing                                                                          |
| `groupMirrors`   | every live mirror whose target is this group                                               | nothing               | nothing                                                                          |
| `userYearQuotas` | every row of the group, a removed member's included                                        | the caller's own rows | nothing, not even from a group the caller has left                               |
| `bankHolidays`   | the group's holiday country                                                                | the group's country   | nothing                                                                          |
| `vacations`      | every row of the group, a removed member's included, plus the rows mirrored into the group | the caller's own rows | the caller's own rows in any group at all, a group they have left included       |
| `groupEvents`    | every group event of the group, recurring and one-off                                      | the same              | nothing                                                                          |
| `birthdays`      | every live member's shared birthday, while the group's organization is paid or lapsed      | nothing               | the caller's own birthday, shared or not, whatever their groups                  |

Detail the table cannot hold:

- **`users`** carries `id`, `name`, `image`, `accountDeleted` and `updatedAt` and nothing else: no
  email. An actor is anyone a returned booking names, meaning `userId`, `approvedBy`, `rejectedBy`,
  `createdByUserId` and `deletedByUserId`, as the booking ships: a column the teammate view nulls
  names nobody. The actors on the bookings a pull carries, and the people
  on the membership rows it carries, arrive whatever their own `updatedAt` says, so no row ever
  names somebody the client cannot resolve. The `createdByUserId` of every group event the pull
  carries is owed the same way, because a creator may have left the group or administer it without
  a membership row. Everybody else in the set arrives only when their own
  row changed in the window, which is how an approver renamed long after a booking settled reaches
  the client.
- **A Deleted account** arrives with `accountDeleted: true`, `image: null` and the frozen name its
  Employment keeps. The caller may share several organizations with the person, and each holds its
  own copy, so the copy on the most recently updated Employment among the organizations of the
  groups the pull covers wins; with none left the name reads "Deleted account". The deletion bumps
  `user.updatedAt`, which is how the stripped row reaches a client already holding the old one. An
  edit to an Employment's copy stamps no user row, so it reaches the phone only on the person's next
  `user` change or a sync reset.
- **A removed member** stays visible in a group seen in full. Their bookings and quota rows are
  still rows of that group, and the web keeps showing them: the group calendar filters only mirrored
  bookings by membership, and the report gives a leaver a summary line. So removal drops their
  `groupUsers` row and nothing else, and their `users` row keeps arriving as the actor on their
  bookings. Mirrors are the exception, below.
- **`organizations`** ships the organization of every group the pull carries, plus any
  organization of a group in the table above whose own row changed in the window. The second half
  is how a rename or a Sick day benefit toggle reaches a client already holding the row: the write
  stamps `organizations.updatedAt` and touches no group. A new trigger or a groups stamp would also
  carry the toggle, but each answers a snapshot to every member of the organization for a one-field
  change. `sickDayBenefitEnabled` is the stored toggle, the one the balance and the report gate the
  Sick day allowance on; a lapsed plan leaves it set while requests stop. It is the one table paged
  by `id` rather than by `updatedAt` then `id`, because two timestamps choose its rows.
- **`groupMirrors`** follows a mirror only while its owner still belongs to the target group, the
  check `getVacationsForGroup` already makes before projecting. A mirror whose owner has left brings
  neither the mirror row nor the bookings it projected. A mirrored booking stays a row of its source
  group, so it carries that group's id and organization, not the target's.
- **`groupEvents`** ships every group event of every group the caller holds a live membership row
  in, a self-scoped group included, because an event belongs to its group rather than to a member.
  A row is the `group_events` row as stored, with the repeat rule as flat columns holding the
  database values (`repeatFreq` `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY`; `repeatMonthlyMode`
  `DAY`, `NTH_WEEKDAY` or `LAST_WEEKDAY`; `repeatWeekdays` 0 = Monday to 6 = Sunday), times as
  `HH:MM` and `skippedDates` sorted. Nothing viewer-dependent ships: no group name, creator summary
  or edit right, which the client derives from `groups`, `users` and `groupUsers`. The client
  expands the occurrences itself. A "this event" edit arrives as two rows, the recurring group event
  with the date added to `skippedDates` and the one-off with `recurringEventId` and `originalDate`.
  No date bound applies: a recurring group event has no last day to bound it by. Joining or leaving
  a group is trigger 1, so no event falls out of scope inside a delta and none needs a tombstone for
  it. Deleting a creator's account nulls `createdByUserId` without stamping `updatedAt`, so a
  client keeps the old id until the row next changes or a sync reset.
- **`birthdays`** is `visibleBirthdays(caller)`, the predicate `GET /api/birthdays` reads. A row is
  keyed by its owner: `id` is the `userId`, because `user_birthdays` has no id of its own, and the
  table pages by `updatedAt` then `userId`. A paid organization is any plan but Free, grace included;
  a lapsed one fell to Free from a subscription or an override and keeps showing its groups' shared
  birthdays. One that never paid shows none. Two rules let a birthday reach the client when it
  becomes visible without its own row changing. Carried with membership: the birthday of anybody
  whose membership row in one of those groups changed in the window arrives whatever its own
  `updatedAt` says, the rule `users` follows, so a colleague joining brings their birthday in the
  same delta. And the fifth reset trigger below covers an organization that starts paying. A row
  the caller may no longer see, because its owner removed it, stopped sharing it or left every group
  that showed it, ships in a delta shaped as a tombstone: `month`, `day` and `year` null, `shared`
  false, `deletedAt` set (to `updatedAt` when the row itself is live). The client drops its copy and
  is never sent the date of a birthday it may not see. The caller's own row always ships in full.
- **`bankHolidays`** ships region-less rows only, for the holiday country of the caller's live
  groups. A group they have left, a soft-deleted one and a mirror's source group each add none: they
  are carried to label a row, not as a calendar the phone marks. Before any row is read, a fresh
  pull runs the lazy fill for every country and year of the window, so a first pull for a new
  country is never empty. The fill also inserts any day the dataset holds and the table lacks, and
  never deletes or rewrites a stored row, since bank holidays have no tombstones. The rows it writes are
  stamped after the pull's position was minted, so the next delta carries them once more.

## Private details

The vacation rows follow the rule in
[`invariants.md`](invariants.md#private-details-and-away-srcservicesvacationredactionts). The owner
of a row, and the approvers and group admins of the row's own group, an org admin of its
organization included, read it whole: every column, its rejected and cancelled states included.
Everyone else who can see the row reads it as a teammate, through `viewVacationRowAs`. Standing is
read against the row's own group, so a row mirrored in keeps its source group's readers and the
target group's approvers get the teammate view.

**The header.** `x-client-sync-accepts` is a comma-separated list of tokens, read
case-insensitively. The token `away` says the client can store `AWAY`, the type a teammate sees in
place of `SICK`. A pull without it gets no teammate's Sick row at all, live or tombstone, because a
phone build that predates `AWAY` holds only the nine stored types and fails the whole page on any
other.

| A teammate's row           | Snapshot | Delta                            |
| -------------------------- | -------- | -------------------------------- |
| live                       | redacted | redacted                         |
| live Sick, without `away`  | absent   | absent                           |
| rejected or cancelled      | absent   | a content-nulled tombstone       |
| rejected or cancelled Sick | absent   | a tombstone with `away`, or none |

Redacted means `note`, `rejectionReason`, `rejectedBy` and `deletedByUserId` null and `SICK` sent
as `AWAY`. Every other column and type is unchanged, `SICK_DAY` included.

A content-nulled tombstone keeps `id`, `userId`, `groupId`, `organizationId`, `requestId`,
`requestedDay`, `halfDay`, `createdAt` and `updatedAt`, carries the redacted `vacationType` and sets
`deletedAt` to the row's own `deletedAt`, or to `updatedAt` for a rejection, as a birthday tombstone
does. Every other column is null. The kept keys are the ones the phone's store declares NOT NULL, so
the row stays storable on every build. `rejectedBy` and `deletedByUserId` are both null on it, while
a rejected or cancelled row a privileged reader receives keeps the actor that set it. That is how
the phone tells the two apart: it drops a tombstone with neither actor and keeps the other as
history. A build that predates the rule keeps both, the content-nulled one showing as cancelled with
no private detail.

The exclusions sit in the vacation reader's `WHERE`, never in a filter after it: `collectSyncPage`
reads a short page as the end of the table, so a row dropped after the read would end the walk
early. Reshaping a row after the read is safe.

An old build holding a teammate's live row that is later edited to Sick keeps the earlier type
until its next sync reset, and if that row is then rejected or cancelled, the tombstone is a Sick
one it is never sent, so it keeps showing the row as live until that reset too. The row carries no
private detail either way.

## History window

Two tables are bounded by their date rather than by their `updatedAt`, and one by the calendar. All
three boundaries are read in UTC from the position the pull was minted with, so they hold still
across every page of a loop.

| Table            | Bounded by     | Window                                                    |
| ---------------- | -------------- | --------------------------------------------------------- |
| `vacations`      | `requestedDay` | from 1 January of the previous year                       |
| `userYearQuotas` | `relatedYear`  | from the previous year                                    |
| `bankHolidays`   | `date`         | 1 January of the previous year to 31 December of the next |

A row dated before its boundary is absent however recently it changed. A cursor minted in an earlier
calendar year than the pull answers a sync reset, because the window has moved and a delta has no
way to tell the client which rows fell out of it.

## Cursor

Opaque, versioned, minted by the server: base64url JSON the client stores verbatim and never parses.
Its position is read when the pull starts, before any row is, so a change landing mid-read falls to
the next pull rather than between the two.

- **Overlap.** A delta returns rows whose `updatedAt` is later than the cursor time less 60 seconds
  and no later than the position this pull was minted with, ordered by `updatedAt` then `id`. The
  overlap covers the clock difference between the database, which stamps inserts, and the server
  instance that stamps updates. A row can therefore arrive twice; clients upsert, so the second
  delivery changes nothing.
- **Expiry.** A cursor whose time is more than 30 days old is unusable: past that it cannot be
  trusted to have covered rows deleted from tables that hold no tombstone.
- **Future bound.** A cursor whose time is more than 60 seconds ahead of the clock reading it is
  unusable, because beyond the overlap its window would skip rows that already existed.
- **Year boundary.** A fresh pull whose cursor was minted in an earlier UTC calendar year answers a
  sync reset rather than a delta, per the history window above. Unlike the two bounds before it,
  this is not a decoding failure: a cursor resuming a paged loop is not checked, so the loop
  finishes on the window it started with.
- **Paging state.** A cursor handed back mid-loop also carries the table the page stopped in, the
  last row it took, whether the loop is a snapshot, and the cursor a delta loop started from. State
  the walk cannot resume from, a keyset missing the timestamp its table orders by or a delta loop
  reaching back past the expiry, makes the whole cursor unusable.
- **Version.** A cursor minted by another version is unusable, so bumping the version makes every
  client take one snapshot. That is the lever for a field added to rows a client already holds,
  which a delta would only deliver as each row next changed. Version 2 added
  `sickDayBenefitEnabled` to organization rows. Version 3 added the `birthdays` table, whose
  existing rows only a snapshot delivers. Version 4 added the `groupEvents` table, for the same
  reason. Version 5 redacted teammates' vacation rows, so every client replaces the notes and
  rejection reasons it holds and sweeps the rows it may no longer see. A cursor that turns unusable mid-loop, the bump
  included, is answered with page one of a fresh snapshot, which says `first: true`. The phone
  restarts its loop whenever a page after its first answers `first: true`, so the fresh snapshot
  runs from page one and its sweep runs.
- **Pages.** Fixed at 1000 rows across all tables, and there is no `limit` parameter. `hasMore` is
  true until the last page; the client loops, applying each page as it lands, and stores only the
  cursor from the page that answered `hasMore: false`. `first` is true on the page that starts a
  loop and false on every page that continues one from the paging state in its cursor. A page
  starts a loop when the request sent no cursor, a bare cursor, or any cursor the server could not
  decode or resume from. The server sets it from its own resume state, and the client never reads
  it off the cursor. The position does not move inside a loop, so no row arrives twice and none is
  skipped; a row that changes between two pages leaves the window and the next delta carries it.
  Tables arrive in dependency order across the loop, so a page resuming inside one table carries
  the tables before it as empty arrays.

An unusable cursor is never an error. It answers a sync reset, exactly as no cursor at all does, and
so does the `cursor` parameter sent more than once.

## Sync reset triggers

Six changes to what the caller may see, which no set of changed rows can express. Each is read once
per pull and for a fresh delta only, over the same window the delta would have covered; a pull
resuming a paged loop stays in the loop it belongs to. A soft delete counts, because it stamps
`updatedAt` like any other write.

1. A `groupUsers` row of the caller, in any group: joining, gaining or losing a flag, or being
   removed. Read whatever its `deletedAt` says, since the caller's own removal is the one trigger
   the live scope can no longer see.
2. A `groupMirrors` row whose target is a group the caller belongs to, added or removed.
3. A `groupUsers` row of a live mirror's owner in the target group of that mirror, when the caller
   belongs to it. A mirror shows only while its owner is a member, so the owner joining or leaving
   changes what the caller sees without touching the mirror row.
4. A `groups` row of a group the caller belongs to, or of the source group of a live mirror into
   one: a manager transfer, an approver change, a rename, a holiday country change or a soft delete.
   A source group's approvers and manager read its mirrored rows whole without belonging to it, so
   their change touches no row of the caller's own. A rename resets too, accepted as rare admin
   activity.
5. A `subscriptions` row of the organization of a group the caller belongs to: checkout, a plan
   change, a cancellation, a renewal webhook. Going from never paid to paid is the one plan change
   that shows birthdays a group did not show, and it touches no row the pull reads. A lapse hides
   none, so grace running out, which writes nothing, needs no trigger. Every write to the row
   resets, not only that one, accepted because subscription writes are rare.
6. An `organization_users` row of the caller, read whatever its `deletedAt` says. Gaining or losing
   org admin changes which groups' rows the caller reads whole, and writes nothing else. A lost
   grant must not leave teammates' private details on the phone.

Anything else stays a delta: another member's booking, a quota edit, a membership change in a group
the caller does not belong to, a mirror into one, a birthday saved, shared or removed, a subscription
of an organization the caller has no group in.

## Tombstones

A delta carries a soft-deleted row in full with `deletedAt` set. Six cases reach a client:

- another member's membership row in a group the caller sees in full;
- a cancelled booking the caller reads whole, which the client keeps as history rather than
  dropping, the way the web calendar shows it. A snapshot carries those cancelled bookings for the
  same reason;
- a teammate's booking rejected or cancelled since the cursor. It ships without its content, shaped
  as described under Private details, and a snapshot leaves it out;
- the row of a group the caller has left and still holds bookings in;
- a birthday the caller may no longer see: removed, unshared, or its owner left every group that
  showed it. Unlike the others it ships without its content, shaped as described under Scope;
- a deleted group event, and the one-offs a delete takes with it. The delete itself wipes the
  content: title, note, times, rule and `createdByUserId` null, `skippedDates` empty. The row keeps
  `id`, `groupId`, the dates, `recurringEventId` and `originalDate`. A snapshot leaves them out.

The rest are reset triggers, so the snapshot that answers them stops carrying the row instead and
the client sweeps whatever the snapshot did not re-send: the caller's own removal, the soft delete
of a group they belong to, and a mirror added to or removed from one of those groups. A
snapshot holds live membership rows and live mirrors only, cancelled bookings the caller reads
whole excepted.

`organizations`, `users`, `userYearQuotas` and `bankHolidays` carry no `deletedAt` and so ship no
tombstones at all.
A person who left, a quota that went and a holiday that fell out of the window stay on the device
until a sync reset sweeps them.

## Transport

- `compression` is mounted on the sync router alone, with `threshold: 0`, so the client's transport
  contract does not depend on how big a page happens to be. This is the only compressed route in the
  API.
- The coding is negotiated from `Accept-Encoding`, Brotli ahead of gzip: `br` for a client that
  accepts it, `gzip` for one that does not, `deflate` where that is all it offers, plain JSON for
  one advertising no coding at all. `Vary` includes `Accept-Encoding`, and the payload is the same
  either way. The e2e suite pins the `gzip` and the `identity` case.
- Every response carries `Cache-Control: no-store`. It is one caller's rows and no cache may hold
  it.
- Any authenticated session answers, native or web, and the route adds no limiter of its own.
