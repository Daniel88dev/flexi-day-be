# Calendar record types

The classification of a vacation row. Code says `CalendarRecordType`; the Postgres enum and column
keep their historical name `vacation_type` ([ADR 0002](adr/0002-calendar-record-type-rename.md)).
Avoid the aliases _leave type_, _vacation type_ and _vacation kind_.

Two rules cut across all nine types:

- **Requestable** — every type except Bank holiday may be created by a member through
  `POST /create-vacation`. Bank holiday is written only by the admin bank-holiday flow: it is a
  company-wide closure, costs no allowance, and shows to the whole team unattributed, so nobody may
  grant themselves one.
- **Quota-bearing** — only Vacation and Home office draw down a `user_year_quotas` allowance
  (`QUOTA_BEARING_TYPES` in `src/services/report/buildSummary.ts`). Every other type books without
  metering.

| Type           | Stored value     | Use when                                                          |
| -------------- | ---------------- | ----------------------------------------------------------------- |
| Vacation       | `VACATION`       | Paid annual leave. The default on a new request.                  |
| Home office    | `HOME_OFFICE`    | Working remotely — an absence from the office, not from work.     |
| Sick           | `SICK`           | Absence due to illness. Distinct from Sick day.                   |
| Sick day       | `SICK_DAY`       | A paid sick day taken as an employee benefit, illness not needed. |
| Paid time off  | `PAID_TIME_OFF`  | Paid absence that is neither annual leave nor a benefit day.      |
| Non-paid leave | `NON_PAID_LEAVE` | Unpaid absence, recorded under its real type.                     |
| Study leave    | `STUDY_LEAVE`    | Time spent studying, tracked apart from vacation.                 |
| Bank holiday   | `BANK_HOLIDAY`   | A company-wide closure. Admin-written, never requested.           |
| Other          | `OTHER`          | Anything the list above doesn't cover; the note says what.        |

`SICK_DAY` was stored as `SICK_LEAVE` until migration `0002_sick_day_rename`.

## Planned, not built

The organization-gated Sick day benefit — a paid subscription switches it on, group admins meter it
against a per-member yearly allowance, and it goes dormant when the subscription lapses — is
designed in Daniel88dev/flexi-day-workspace#4. Today the backend treats Sick day as an ordinary
unmetered requestable type; this section moves above when that lands.
