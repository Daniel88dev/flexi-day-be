# Context: flexi-day-be

The vacation/day-off domain as the backend models it. Security and permission boundaries live in
[`docs/invariants.md`](docs/invariants.md).

## Glossary

| Term                     | Meaning                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vacation**             | One booking row for one user, one group, one day. A multi-day request is many rows.                                                                                                                                         |
| **Vacation event**       | Append-only timeline entry per vacation (created / approved / rejected / cancelled / updated).                                                                                                                              |
| **Group**                | A team. Has a manager, working days, a holiday country, default quotas, and a list of approvers.                                                                                                                            |
| **Manager**              | The group's owner. Usually also holds a `group_users` row with every flag set, created with the group.                                                                                                                      |
| **Approver**             | May decide member-submitted requests in a group. Main or temp.                                                                                                                                                              |
| **Group admin**          | May administer a group: the manager, or an org admin of the owning organization.                                                                                                                                            |
| **Organization**         | Billing owner above groups. One per user, created lazily.                                                                                                                                                                   |
| **Org admin**            | The organization's owner, or a delegate holding an `organization_users` row.                                                                                                                                                |
| **Quota**                | A user's allowance for one year in one group (`user_year_quotas`).                                                                                                                                                          |
| **Calendar record type** | The classification of a vacation row. Nine types, each with its own conditions — see [`docs/calendar-record-types.md`](docs/calendar-record-types.md). Avoid: leave type, vacation type, vacation kind.                     |
| **Sick day benefit**     | Paid-plan organization toggle that makes Sick day a requestable, metered type — see [`docs/calendar-record-types.md`](docs/calendar-record-types.md).                                                                       |
| **Mirror**               | A read-side projection of a user's records from one group into another.                                                                                                                                                     |
| **Invite**               | A single-use, expiring offer for one email address to join one group.                                                                                                                                                       |
| **Invite code**          | The short code of an invite, shown to the admin so they can pass it on. Avoid: validation code.                                                                                                                             |
| **Invite link**          | The URL in the invite email. Following it proves control of the mailbox.                                                                                                                                                    |
| **Request**              | The set of Vacation rows created by one submission, sharing a `request_id`. Attachments and retention hang off it, not the day.                                                                                             |
| **Attachment**           | An image or PDF bound to one Request. Seen by the record owner, the group's approvers and group admins; nobody else. Bytes live in S3, or on disk without a bucket (`docs/adr/0003`).                                       |
| **Live row**             | A vacation row a reader returned under `deleted_at IS NULL`. `LiveVacationType` is its type.                                                                                                                                |
| **Attendance settings**  | The organization's attendance rules, one row keyed by organization. No row means attendance was never set up. See [`docs/attendance.md`](docs/attendance.md).                                                               |
| **Employment**           | One person's membership in one organization: the subject of attendance. Starts, and may end. Avoid: employee, staff, org member.                                                                                            |
| **Attendance session**   | One clock-in to clock-out span for one Employment. A day may hold several. Avoid: shift (reserved for a future feature), punch, timesheet entry.                                                                            |
| **Entered session**      | An attendance session recorded after the fact rather than clocked, and marked as such for good. See [`docs/attendance.md`](docs/attendance.md). Avoid: manual punch, backfill.                                              |
| **Self-service window**  | The business dates on which an employee may enter or change their own attendance, as the organization sets it. Outside it, only an admin can. See [`docs/attendance.md`](docs/attendance.md).                               |
| **Business date**        | The calendar day an attendance session belongs to, fixed at clock-in from the organization's timezone and never moved. Avoid: work date.                                                                                    |
| **Break**                | A pause inside an attendance session, started live or added afterwards.                                                                                                                                                     |
| **Presence**             | Clock-out minus clock-in for one session, summed per business date.                                                                                                                                                         |
| **Worked time**          | Presence minus the larger of the organization's break allowance and the breaks actually taken. See [`docs/attendance.md`](docs/attendance.md).                                                                              |
| **Required time**        | The worked time an Employment owes on a working day: the organization's rule unless the Employment overrides it.                                                                                                            |
| **Excluded day**         | A business date on which no attendance is owed: a date outside the Employment's spell, a non-working day, a public holiday, or an approved absence. See [`docs/attendance.md`](docs/attendance.md).                         |
| **Balance mode**         | Whether required time is measured per day or per month. Changes only how the numbers are presented; nothing is enforced.                                                                                                    |
| **Team attendance**      | The admin dashboard: every Employment the viewer may see, per the visibility table, with each person's days over a range and who is clocked in now. See [`docs/attendance.md`](docs/attendance.md).                         |
| **Attendance event**     | Append-only timeline entry per attendance session. A null changing user means the auto-close sweep wrote it, not a person. Its payload is redacted, never deleted, when retention catches up with it.                       |
| **Location fix**         | Latitude, longitude and accuracy from the browser at one end of an attendance session. Never required, erased after twelve months. See [`docs/attendance.md`](docs/attendance.md).                                          |
| **Sync pull**            | One `GET /api/sync/pull` answering every row the caller can see that changed since the sync cursor, across all their organizations, paged. See [`docs/sync-pull.md`](docs/sync-pull.md). Avoid: sync, fetch changes.        |
| **Sync cursor**          | The opaque position a sync pull hands back and the next one sends in. Minted by the server, never read by a client. See [`docs/sync-pull.md`](docs/sync-pull.md). Avoid: last sync time, watermark.                         |
| **Tombstone**            | A soft-deleted row a sync pull returns in full with `deletedAt` set, so the client can drop or archive its copy. See [`docs/sync-pull.md`](docs/sync-pull.md). Avoid: deletion marker.                                      |
| **Sync reset**           | A sync pull that answers with a full snapshot instead of a delta: no cursor, an undecodable or expired one, or a change to what the caller may see. See [`docs/sync-pull.md`](docs/sync-pull.md). Avoid: full sync, resync. |
| **Native session**       | A session created by the phone app. Bound to one Device id, valid ten years or until sign-out, password reset, or a sign-in on the same phone. Avoid: mobile session, app session.                                          |
| **Device id**            | An opaque id the phone mints once and keeps in its Keychain; sent on every request and checked against the Native session it belongs to. Identifies the phone, not the person. Avoid: install id, app instance id.          |

## Vacation workflow

1. User creates a vacation request for a group over an inclusive date range (`from`/`to` on
   `POST /create-vacation`; a single day is `from == to`). One row is stored per day.
2. The request is pending until an approver decides it.
3. A group has main approvers and optional temp approvers.
4. Approval updates vacation status and quota tracking.
5. Quota changes are logged in `changes`.
6. Every transition also appends a `vacation_events` row **inside the same transaction**, and
   `src/services/vacation/vacationNotifier.ts` fans out the email + in-app notification
   **after** the commit. `src/services/vacation/vacationTransitions.ts` is what holds that
   ordering: approve, reject, cancel and comment, single and bulk alike, all run through its one
   sequence, so a new transition inherits the ordering instead of restating it. Creating and
   editing a booking still order it by hand in their own handlers.
   The notifier swallows and logs its own errors on purpose — a mail
   failure must never turn a committed change into a 5xx the client would retry. Workflow mail
   respects `user_settings.emailNotifications`; account mail (email confirmation) does not.

## Group structure

- Groups have a manager (userId) and defined quotas.
- Users link to groups via `group_users` with role permissions.
- Each user has yearly quotas per group in `user_year_quotas`.
- A user may belong to no group at all. `teamName` is optional on
  `/api/auth/sign-up-with-team`, so an account can exist before it has anywhere to book time
  off — `handlePostVacation` gates booking on the membership, not on sign-up.

## Organization admins

A second, orthogonal route to group administration. The org owner may delegate ADMIN to one of the
organization's own people; a delegate then administers **every** group in that organization
without belonging to any of them. What a delegate may and may not do is a boundary, not a
convention — see [`docs/invariants.md`](docs/invariants.md#organization-admin-boundary-organization_users).

## Joining a group (`invite_link`)

An admin issues an invite with `POST /api/group-user/{groupId}/invites`. It is emailed via the
`group-invite` SES template, and its code comes back in the response so the admin can pass it on
when the mail fails (`emailDelivered: false`). An invite is **bound to the address it was issued
to**, and has three ways in:

- **Invite code**, `POST /api/group-user/code/{code}` (`handlePostGroupUser`). The session's
  address must match the invite and be verified already. The admin knows the code, so it proves
  nothing about the mailbox.
- **Invite link**, `{appUrl}/join/?token=<secret>`, only in the email. The frontend's `/join/` page
  describes it through the public `POST /api/auth/invite/preview` and joins through
  `POST /api/auth/invite/join` (`handlePostInviteJoin`) when the user presses Join, never on load.
  The session's address must match, and the join verifies it if it was not, because following the
  link is itself the proof — see [`docs/invariants.md`](docs/invariants.md). The secret is stored
  only as a hash, in `link_secret_hash`, and no API returns it.
- **Sign up with invite**, `POST /api/auth/invite/sign-up` (`handlePostInviteSignUp`): the invite
  link for an invitee with no account, creating a verified account already in the group — see
  [`docs/invariants.md`](docs/invariants.md).

All three go through `redeemInvite`: the same member defaults, seat-cap check and quota opening,
and any one of them uses up the invite for all. Re-inviting an address revokes the open invite, code and
link together. Single use is enforced by the `usedAt IS NULL` predicate in the redeeming UPDATE, so
concurrent redemptions cannot both win. Rows with a null `email` predate email invites and stay
redeemable by anyone holding the code; rows with a null `link_secret_hash` predate invite links and
redeem by code only.

## Mirroring (`group_mirrors`)

A user can opt to have their records from a source group displayed inside another group they
belong to — a manager showing their own approved leave to their team, or several small teams
feeding one umbrella group. It is a **read-side projection only**: no vacation row is ever copied,
so a mirrored record is still approved, counted against quotas and reported in its source group
alone. Two consequences worth keeping intact:

- Mirrored records are never approvable in the target group. Nothing enforces this explicitly —
  the approval queries key on `vacation.groupId`, and that is why they must keep doing so.
- Active membership of the target group is re-checked before projecting, so someone who leaves does
  not keep leaking time off into it. Two readers do it: `getVacationsForGroup` for the web, and the
  sync pull, which follows a mirror only while its owner still belongs to the target group and
  treats that membership changing as a sync reset trigger.

## Quota rollover

A croner job (`src/jobs/`) rolls unused quota into the new year. `QUOTA_ROLLOVER_ENABLED` toggles it
(on outside `test`), `QUOTA_ROLLOVER_CRON` sets the schedule (default `0 2 * * *`) and
`QUOTA_ROLLOVER_TIMEZONE` the zone it runs in (default `Europe/Prague`). Rows it writes to `changes`
carry a null `changing_user_id`, which is how an automated rollover is told apart from a person.

The same tick then runs the attachment retention sweep (`src/services/attachment/attachmentRetention.ts`):
attachments go twelve months after the Request's last day, as soon as the Request has no live day
left (every day cancelled or rejected), and `UPLOADING` rows older than ten minutes are cleared.
Each case removes the object and the row; a user's own delete only soft-deletes, keeping the row as
the history entry until one of the sweep cases catches the Request.

Two attendance sweeps ride the same tick. `attendance/attendanceRetention.ts` erases coordinates
twelve months past the business date, and `attendance/attendanceCeilings.ts` closes what an employee
forgot — a session left running past its organization's ceiling, at `started_at` plus the ceiling
rather than at the instant the tick ran, and a break past its own. Neither asks the plan: a lapse
must not leave a clock open forever.

## Undeliverable recipients

`emailSender` is wrapped by `src/services/email/suppressUndeliverable.ts` so recipients at reserved
domains — RFC 2606/6761 (`.test`, `.example`, `.invalid`, `.localhost`, `example.com/.net/.org`)
and RFC 6762 `.local` — are logged as `email.suppressed` and dropped instead of handed to SES. That
covers the seeded `@dev.local` accounts, whose mail would otherwise hard-bounce and cost the SES
account sender reputation. The rule keys on the domain alone, **not** on `NODE_ENV` or
`DEV_SEED_EMAIL_DOMAIN`: pointing the seed domain at a domain you actually own is how you exercise
real delivery locally, and that has to keep sending. It applies in production too — a
reserved-domain address there is bad data, and bouncing it helps nobody.

## Schema notes

`src/db/schema/` is mostly self-describing. The rows that are not:

- `changes-schema.ts` — `changing_user_id` is nullable; NULL means the scheduled quota rollover
  wrote the row rather than a person.
- `organization-users-schema.ts` — **delegated** org admins only. The owner is
  `organizations.ownerUserId` and holds no row, so org admin is always owner-or-row.
- `report-export-schema.ts` / `support-access-schema.ts` — write-only audit trails; nothing reads
  them back.
- `user-settings-schema.ts` — a missing row means defaults, not opt-out.
- `employment-schema.ts` — unique on `(organization_id, user_id)`, so the row is the person's
  **current** spell in that organization, not a history: a rejoin reopens it with a new
  `started_at` and the earlier spell is gone.
- `attendance-schema.ts` — "one open session per Employment" and "one open break per session" are
  partial unique indexes on the null `ended_at`, not handler checks; the reads that precede an
  insert are for the error message. The six location columns are null unless the organization
  switched location on and the browser's prompt was allowed, and null again once the retention
  sweep has passed over them — a declined prompt and an erased one look the same, deliberately.
- `paddle-event-schema.ts` — webhook idempotency, not billing state (that is
  `subscription-schema.ts`).
