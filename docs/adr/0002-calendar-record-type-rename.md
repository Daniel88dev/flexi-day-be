# Code says `CalendarRecordType`; the database keeps `vacation_type`

The classification of a booking row (vacation, home office, sick, …) had four names, none of them
chosen: `vacationType` in the Drizzle schema and API, `VacationKind` in the frontend, `leaveType`
in the quota guard, emails and charts, `LeaveTypeKey` in the dashboard subset. In August 2026 we
unified all TypeScript code, in both repos, on **`CalendarRecordType`** — deliberately not
"vacation type" or "leave type", because the concept covers records that are neither: home office
is an absence from the office, not from work, and a bank holiday is nobody's leave.

The Postgres enum and column keep their historical name `vacation_type`. Renaming a live enum and
column in production is a migration whose only payoff is aesthetic, and every ORM-level rename is
one more chance for a deploy to disagree with the schema. The trade is a permanent seam: anyone
reading raw SQL sees `vacation_type` and must know it is the same concept. The glossary in
`CONTEXT.md` records the mapping, and this file records that the mismatch is deliberate — do not
"fix" the code back to the column's name.

## What would reverse this

A schema migration that has to touch the enum anyway — splitting the type into its own table, or
reworking the vacation table wholesale. If the enum is being rewritten regardless, renaming it to
match the code costs nothing extra and should be done then, not before.
