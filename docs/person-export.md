# Person export

The rules behind the **Person export** row in [`GLOSSARY.md`](../GLOSSARY.md). It is the
organization's tool for a person's access or portability request: a ZIP of everything the
organization holds about one person. The work is in `src/services/personExport/`.

## Who can request one

- The owner and org admins, for any Employment from its People card row: open or ended, account
  bound or deleted, on every plan. `POST /api/employment/{employmentId}/export`. Group managers and
  members get 403.
- The person, for each organization where their account is bound to an Employment, open or ended,
  from the "Your data" card in Settings. `GET` and `POST /api/users/me/person-exports`.
- A second request by the same person for the same subject while one is still `PENDING` returns
  that one.

## What it holds

One organization's Organization data about the person, across every spell. The name and email are
the Employment's own copies.

| File                      | Contents                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `person.json`             | Everything below, plus Employments, group memberships, managed groups and the Read log's dates and purposes |
| `bookings.csv`            | Every booking in any state, with the names of who created, approved, rejected or cancelled it               |
| `attendance-sessions.csv` | Sessions with break minutes and any location fixes still held; breaks and events are in `person.json`       |
| `quotas.csv`              | Each year's allowance per group                                                                             |
| `changes.csv`             | The change log entries about the person                                                                     |
| `attachments/`            | The bytes of every attachment still held                                                                    |

Account data stays out: login, the account's own name and email, Account picture, sessions,
settings, notifications, Birthday. Reader names never appear in the Read log section, only the
purpose (owner, organization administration, self-service). A CSV cell that starts like a formula
gets a leading `'`. Employment type and the profile sections join the file when they exist.

## Delivery

- A request writes a `person_exports` row (`PENDING`) and one `export` row in the Read log, in one
  transaction. After the commit the in-process queue builds the ZIP.
- A build holds a session advisory lock on the export id for its whole run, on a connection of its
  own. A second instance gets busy and tries again after 30 seconds. A process that dies drops the
  connection and the lock, and the boot catch-up (`startPersonExportQueue`) queues every `PENDING`
  row again. A failed build retries after 30 seconds, 5 minutes and 30 minutes, then the row is
  `FAILED`.
- The build reads attachment bytes from the attachments bucket, writes the ZIP to a temporary file
  and puts it at `exports/{organizationId}/{exportId}.zip` in the organization-data bucket, or the
  disk store under `ORGANIZATION_DATA_DIR` without one. In production without
  `ORGANIZATION_DATA_BUCKET` the request routes answer 503 `EXPORT_UNAVAILABLE`.
- `READY` sets `expiresAt` 7 days on, matching the bucket's `exports/` lifecycle rule. The
  requester gets one `export_ready` Notification, in-app and pushed, never emailed.
- Erasing the person deletes their Person exports and the organization's Organization exports,
  rows and ZIPs (see [`account-deletion.md`](account-deletion.md#erase)).
- `POST /api/person-exports/{exportId}/download` signs a link for one hour, for the requester only.
  It signs again as often as asked until `expiresAt`, then answers 410 `EXPORT_EXPIRED`.
  Every signing re-checks the standing the export was requested with: the owner for an
  Organization export, an org admin of the organization for someone else's Person export. An
  admin whose grant was revoked gets 403 `FORBIDDEN`, even for a file that is still ready.

## Organization export

The owner's copy of everything the organization holds, and the return option at the end of the
service (Art. 28(3)(g)). Only the owner can request it, from the Organization page, at any time and
on every plan: `POST /api/organization/export`, and `GET` for the newest one. A delegated admin gets
403 `OWNER_ONLY`. The delete dialog links to it but never waits for it.

| Path                   | Contents                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `organization.json`    | The organization, its settings and attendance settings history, administrators, groups, memberships, group events, a people index |
| `people/<name>-<id8>/` | One Person export folder per person with an Employment there, open or ended, Deleted accounts included                            |

It is a `person_exports` row with `scope` `ORGANIZATION` and no subject, so it shares the queue,
the lock, the store key, the signed link and the `export_ready` Notification. The request writes one
`export` row in the Read log for every person in it, under the `OWNER` audience. The build reads
one person at a time into the ZIP.

## Deleting the organization

Every export of an organization, Person and Organization alike, lives under
`exports/{organizationId}/`. When the owner's Account deletion takes the organization, the rows
cascade, and after the commit `removeOrganizationExports` deletes every object under that prefix
rather than waiting for the 7-day lifecycle rule. On S3 the bucket keeps the old versions behind a
delete marker until its 7-day noncurrent rule removes them. A build that finishes after its row went
deletes its own file.

## The Read log

`read_log` is append-only. No route updates or deletes a row, and a trigger refuses every UPDATE.
Rows go only with their organization, and an Erase leaves them in place. Each row names the reader, the person, the spells
(`employmentIds`, no foreign key, so a row outlives an erasure) and the audience the reader acted
under. Sensitive-section reads will land in the same table with a kind of their own.
