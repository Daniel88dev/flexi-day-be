# Sync pull

The rules behind the sync glossary rows in [`CONTEXT.md`](../CONTEXT.md). One endpoint,
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
  "organizations": [],
  "users": [],
  "groups": [],
  "groupUsers": [],
  "groupMirrors": [],
  "userYearQuotas": [],
  "bankHolidays": [],
  "vacations": []
}
```

The eight table keys are always present, in that dependency order, so a client can apply a page top
to bottom. They are the Drizzle export names, pluralised where the schema's is singular: `users` for
`user`, `vacations` for `vacation`. Rows are raw table rows: camelCase column names, timestamps
ISO 8601 UTC, dates `YYYY-MM-DD`, no joined summaries and no per-row verdicts. `note` and
`rejectionReason` ship, because the web shows them to everyone who can see the row.

Every partitioned row carries `organizationId`: groups carry their own, `groupUsers`,
`userYearQuotas` and `vacations` their group's, `groupMirrors` the target group's. `users` and
`bankHolidays` are unpartitioned reference data and carry none.

## Scope

Scope is membership-only, exactly the web dashboard and calendar, and comes from the report
service's scope entries (`getScopeEntries`). One level per group drives every table: `all` when the
caller's membership row carries view or admin access or they are the group's manager, `self`
otherwise. A group the caller holds no live membership row in is absent whatever else they are
there, an org admin of the owning organization or the group's own manager. A delta resolves the same scope with soft-deleted groups kept, which the
report scope drops, so a group soft-deleted before the window the delta covers still counts as one
of the caller's while their membership row lives.

| Table            | Seen in full (`all`)                                                                       | Self-scoped (`self`)  | Beyond those groups                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------- |
| `organizations`  | the organization of the group, id and name only                                            | the same              | the organization of any other group the pull names                               |
| `users`          | every member and the manager                                                               | the caller            | every actor on a visible booking                                                 |
| `groups`         | the group row                                                                              | the group row         | a group the caller has left but still holds bookings in; a mirror's source group |
| `groupUsers`     | the full live member list                                                                  | the caller's own row  | nothing                                                                          |
| `groupMirrors`   | every live mirror whose target is this group                                               | nothing               | nothing                                                                          |
| `userYearQuotas` | every row of the group, a removed member's included                                        | the caller's own rows | nothing, not even from a group the caller has left                               |
| `bankHolidays`   | the group's holiday country                                                                | the group's country   | nothing                                                                          |
| `vacations`      | every row of the group, a removed member's included, plus the rows mirrored into the group | the caller's own rows | the caller's own rows in any group at all, a group they have left included       |

Detail the table cannot hold:

- **`users`** carries `id`, `name`, `image` and `updatedAt` and nothing else: no email, no account
  state. An actor is anyone a returned booking names, meaning `userId`, `approvedBy`, `rejectedBy`,
  `createdByUserId` and `deletedByUserId`. The actors on the bookings a pull carries, and the people
  on the membership rows it carries, arrive whatever their own `updatedAt` says, so no row ever
  names somebody the client cannot resolve. Everybody else in the set arrives only when their own
  row changed in the window, which is how an approver renamed long after a booking settled reaches
  the client.
- **A removed member** stays visible in a group seen in full. Their bookings and quota rows are
  still rows of that group, and the web keeps showing them: the group calendar filters only mirrored
  bookings by membership, and the report gives a leaver a summary line. So removal drops their
  `groupUsers` row and nothing else, and their `users` row keeps arriving as the actor on their
  bookings. Mirrors are the exception, below.
- **`organizations`** is read off the groups, not off itself: a row ships only while the group row
  that named it falls in the pull's window, so a rename on its own reaches the client on the next
  pull that carries one of that organization's groups. It is also the one table paged by `id`
  rather than by `updatedAt` then `id`.
- **`groupMirrors`** follows a mirror only while its owner still belongs to the target group, the
  check `getVacationsForGroup` already makes before projecting. A mirror whose owner has left brings
  neither the mirror row nor the bookings it projected. A mirrored booking stays a row of its source
  group, so it carries that group's id and organization, not the target's.
- **`bankHolidays`** ships region-less rows only, for the holiday country of the caller's live
  groups. A group they have left, a soft-deleted one and a mirror's source group each add none: they
  are carried to label a row, not as a calendar the phone marks. Before any row is read, a fresh
  pull runs the lazy fill for every country and year of the window, so a first pull for a new
  country is never empty. The rows it writes are stamped after the pull's position was minted, so
  the next delta carries them once more.

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
- **Pages.** Fixed at 1000 rows across all tables, and there is no `limit` parameter. `hasMore` is
  true until the last page; the client loops, applying each page as it lands, and stores only the
  cursor from the page that answered `hasMore: false`. The position does not move inside a loop, so
  no row arrives twice and none is skipped; a row that changes between two pages leaves the window
  and the next delta carries it. Tables arrive in dependency order across the loop, so a page
  resuming inside one table carries the tables before it as empty arrays.

An unusable cursor is never an error. It answers a sync reset, exactly as no cursor at all does, and
so does the `cursor` parameter sent more than once.

## Sync reset triggers

Four changes to what the caller may see, which no set of changed rows can express. Each is read once
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
4. A `groups` row of a group the caller belongs to: a manager transfer, a rename, a holiday country
   change or a soft delete. A rename resets too, accepted as rare admin activity.

Anything else stays a delta: another member's booking, a quota edit, a membership change in a group
the caller does not belong to, a mirror into one.

## Tombstones

A delta carries a soft-deleted row in full with `deletedAt` set. Three cases reach a client:

- another member's membership row in a group the caller sees in full;
- a cancelled booking, which the client keeps as history rather than dropping, the way the web
  calendar shows it. A snapshot carries cancelled bookings for the same reason;
- the row of a group the caller has left and still holds bookings in.

The rest are reset triggers, so the snapshot that answers them stops carrying the row instead and
the client sweeps whatever the snapshot did not re-send: the caller's own removal, the soft delete
of a group they belong to, and a mirror added to or removed from one of those groups. A
snapshot holds live membership rows and live mirrors only, cancelled bookings excepted.

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
