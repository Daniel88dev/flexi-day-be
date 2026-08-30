# Calendar record types

The classification of a vacation row. Code says `CalendarRecordType`; the Postgres enum and column
keep their historical name `vacation_type` ([ADR 0002](adr/0002-calendar-record-type-rename.md)).
Avoid the aliases _leave type_, _vacation type_ and _vacation kind_.

Three rules cut across all nine types:

- **Requestable** — every type except Bank holiday may be created by a member through
  `POST /create-vacation`. Bank holiday is written only by the admin bank-holiday flow: it is a
  company-wide closure, costs no allowance, and shows to the whole team unattributed, so nobody may
  grant themselves one. Sick day is requestable only while the organization's Sick day benefit is
  active (see below).
- **Quota-bearing** — Vacation, Home office and Sick day draw down a `user_year_quotas` allowance
  (`QUOTA_BEARING_TYPES` in `src/services/report/buildSummary.ts`). Every other type books without
  metering. Carry-over belongs to Vacation alone: the yearly rollover copies every allocation
  forward but rolls only unused vacation days into `carriedOverDays` — unused home office and sick
  days expire.
- **Exportable** — every type except Bank holiday appears in the Excel export
  (`EXPORTABLE_CALENDAR_RECORD_TYPES` in `src/services/report/types.ts`). The export answers what
  leave people took, and a company-wide closure is not part of that answer; `POST /export` rejects
  `BANK_HOLIDAY` as a filter and excludes its rows even without one. The overview endpoint still
  accepts and returns it, though the frontend no longer offers it as a filter option anywhere.

| Type           | Stored value     | Use when                                                        |
| -------------- | ---------------- | --------------------------------------------------------------- |
| Vacation       | `VACATION`       | Paid annual leave. The default on a new request.                |
| Home office    | `HOME_OFFICE`    | Working remotely — an absence from the office, not from work.   |
| Sick           | `SICK`           | Absence due to illness. Distinct from Sick day.                 |
| Sick day       | `SICK_DAY`       | A paid sick day from the org-gated benefit, illness not needed. |
| Paid time off  | `PAID_TIME_OFF`  | Paid absence that is neither annual leave nor a benefit day.    |
| Non-paid leave | `NON_PAID_LEAVE` | Unpaid absence, recorded under its real type.                   |
| Study leave    | `STUDY_LEAVE`    | Time spent studying, tracked apart from vacation.               |
| Bank holiday   | `BANK_HOLIDAY`   | A company-wide closure. Admin-written, never requested.         |
| Other          | `OTHER`          | Anything the list above doesn't cover; the note says what.      |

`SICK_DAY` was stored as `SICK_LEAVE` until migration `0002_sick_day_rename`.

## The Sick day benefit

Sick day is an organization-gated benefit (designed in Daniel88dev/flexi-day-workspace#4). The
toggle is `organizations.sick_day_benefit_enabled`, default off, editable by any org admin via
`PATCH /api/organization`; switching it **on** requires a paid plan
(`assertCanEnableSickDayBenefit`), switching it off never does.

The benefit is _active_ — and `SICK_DAY` requestable — only while the toggle is on **and** the plan
is currently paid (`isSickDayBenefitActive` in `src/services/billing/guards.ts`; grace counts as
paid). That derived check is the whole dormancy mechanism: a lapsed subscription withdraws new
requests without touching the toggle, the allowances or any booked record, and re-subscribing
restores the benefit as it was. Editing a record that is already a Sick day keeps working through a
lapse; retyping another record _to_ Sick day does not.

Members learn whether the benefit is active from the organization badge that rides along with
`GET /api/group/:groupId` — `organization.sickDayBenefitActive`, the same derived rule — so the
request form can gate the type without an admin-only call.

The allowance lives beside the other metered types — `user_year_quotas.sick_days` with a
`groups.default_sick_days` starting value — and is edited through the existing quota endpoints.
Report summaries and the export's summary sheet show a Sick day line for groups whose organization
has the toggle on (the toggle, not the live plan, so a lapsed organization's reports stay
complete).
