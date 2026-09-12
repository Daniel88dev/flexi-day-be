# Context: flexi-day-be

The vacation/day-off domain as the backend models it. Security and permission boundaries live in
[`docs/invariants.md`](docs/invariants.md).

## Glossary

| Term                     | Meaning                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vacation**             | One booking row for one user, one group, one day. A multi-day request is many rows.                                                                                                                                    |
| **Vacation event**       | Append-only timeline entry per vacation (created / approved / rejected / cancelled / updated).                                                                                                                         |
| **Group**                | A team. Has a manager, working days, a holiday country, default quotas, and a list of approvers.                                                                                                                       |
| **Manager**              | The group's owner. Holds no `group_users` row.                                                                                                                                                                         |
| **Approver**             | May decide member-submitted requests in a group. Main or temp.                                                                                                                                                         |
| **Group admin**          | May administer a group: the manager, or an org admin of the owning organization.                                                                                                                                       |
| **Organization**         | Billing owner above groups. One per user, created lazily.                                                                                                                                                              |
| **Org admin**            | The organization's owner, or a delegate holding an `organization_users` row.                                                                                                                                           |
| **Quota**                | A user's allowance for one year in one group (`user_year_quotas`).                                                                                                                                                     |
| **Calendar record type** | The classification of a vacation row. Nine types, each with its own conditions — see [`docs/calendar-record-types.md`](docs/calendar-record-types.md). Avoid: leave type, vacation type, vacation kind.                |
| **Sick day benefit**     | Paid-plan organization toggle that makes Sick day a requestable, metered type — see [`docs/calendar-record-types.md`](docs/calendar-record-types.md).                                                                  |
| **Mirror**               | A read-side projection of a user's records from one group into another.                                                                                                                                                |
| **Invite link**          | Single-use code binding one email address to one group.                                                                                                                                                                |
| **Request**              | The set of Vacation rows created by one submission, sharing a `request_id`. Attachments and retention hang off it, not the day.                                                                                        |
| **Attachment**           | An image or PDF bound to one Request. Seen by the record owner, the group's approvers and group admins; nobody else. Bytes live in S3, or on disk without a bucket (`docs/adr/0003`).                                  |
| **Live row**             | A vacation row a reader returned under `deleted_at IS NULL`. `LiveVacationType` is its type.                                                                                                                           |
| **Employment**           | One person's membership in one organization: the subject of attendance. Starts, and may end. Avoid: employee, staff, org member.                                                                                       |
| **Attendance session**   | One clock-in to clock-out span for one Employment. A day may hold several. Avoid: shift (reserved for a future feature), punch, timesheet entry.                                                                       |
| **Business date**        | The calendar day an attendance session belongs to, fixed at clock-in from the organization's timezone and never moved. Avoid: work date.                                                                               |
| **Break**                | A self-initiated pause inside an open attendance session.                                                                                                                                                              |
| **Presence**             | Clock-out minus clock-in for one session, summed per business date.                                                                                                                                                    |
| **Worked time**          | Presence minus the larger of the organization's break allowance and the breaks actually taken. See [`docs/attendance.md`](docs/attendance.md).                                                                         |
| **Required time**        | The worked time an Employment owes on a working day: the organization's rule unless the Employment overrides it.                                                                                                       |
| **Excluded day**         | A business date on which no attendance is owed: a non-working day, a public holiday, or a day with a live approved absence. Clocking in on one is allowed and flagged. See [`docs/attendance.md`](docs/attendance.md). |
| **Balance mode**         | Whether required time is measured per day or per month. Changes only how the numbers are presented; nothing is enforced.                                                                                               |
| **Attendance event**     | Append-only timeline entry per attendance session. A null changing user means the auto-close sweep wrote it, not a person.                                                                                             |

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

An admin issues a single-use code with `POST /api/group-user/{groupId}/invites`; it is emailed via
the `group-invite` SES template and also returned so the admin can pass it on when the mail fails
(`emailDelivered: false`). A code is **bound to the address it was issued to** —
`handlePostGroupUser` refuses a redeemer whose session email differs. Rows with a null `email`
predate email invites and stay unrestricted. Single-use is enforced by the `usedAt IS NULL`
predicate in the redeeming UPDATE, so concurrent redemptions cannot both win.

## Mirroring (`group_mirrors`)

A user can opt to have their records from a source group displayed inside another group they
belong to — a manager showing their own approved leave to their team, or several small teams
feeding one umbrella group. It is a **read-side projection only**: no vacation row is ever copied,
so a mirrored record is still approved, counted against quotas and reported in its source group
alone. Two consequences worth keeping intact:

- Mirrored records are never approvable in the target group. Nothing enforces this explicitly —
  the approval queries key on `vacation.groupId`, and that is why they must keep doing so.
- `getVacationsForGroup` re-checks active membership of the target group before projecting, so
  someone who leaves does not keep leaking time off into it.

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
- `paddle-event-schema.ts` — webhook idempotency, not billing state (that is
  `subscription-schema.ts`).
