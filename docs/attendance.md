# Attendance

The rules behind the attendance glossary rows in [`CONTEXT.md`](../CONTEXT.md). Roles are the
existing ones: an Org admin administers every Employment in the organization, a Group admin those
of the group's members. No attendance-specific role exists.

## Subject

Attendance belongs to an **Employment**, one row per person per organization, never to a group. A
person clocks in once regardless of how many groups they belong to. A person in no group is still
an Employment if they own the organization, hold a delegated admin row, or manage a group.

## Session

- One open session per Employment at a time. A clock-in while one is open is refused and the caller
  is told when the open one started.
- The clock-in instant is the server's, never the client's.
- `businessDate` is fixed at clock-in from the organization's timezone and never moves, so a session
  that crosses midnight belongs wholly to the day it started.
- A session left open past the organization's ceiling (default 16 h) is closed by the sweep at
  `startedAt + ceiling` and marked as auto-closed. The same applies to a break left open past its
  own ceiling. Both show on the dashboard as needing correction.
- A break may start only inside an open session; an open break is closed at clock-out and counted
  to that instant.

## Worked time

```
presence   = Σ (endedAt − startedAt) over the sessions of one businessDate
deducted   = presence > breakThreshold ? max(breakAllowance, breaksTaken) : breaksTaken
workedTime = presence − deducted
```

`breakAllowance` and `breakThreshold` (default 6 h) are organization settings. The allowance is
deducted whether or not a break was taken, but only once presence passes the threshold.

## Required time

The organization's `requiredMinutesPerDay` unless the Employment overrides it. Required presence is
therefore required time plus the break allowance.

**Balance mode** decides only presentation: `DAILY` colours each day against required time,
`MONTHLY` shows one balance against required time × working days in the month. Neither mode
enforces anything; nothing is blocked, and month-end balances neither carry over nor reset — they
are reported and left to the employer.

## Excluded days

No attendance is owed on a business date that is:

- not one of the organization's `workingDays`;
- a public holiday for the organization's `holidayCountry`;
- covered by a live, approved absence of type `VACATION`, `SICK`, `SICK_DAY`, `PAID_TIME_OFF`,
  `NON_PAID_LEAVE`, `STUDY_LEAVE` or `OTHER`.

`HOME_OFFICE` does not exclude a day: working from home is working. A `halfDay` record halves the
required time for that day rather than excluding it.

The organization carries its own timezone, holiday country and working days for attendance. A
group's settings are never read, because an Employment is not group-shaped.

Clocking in on an excluded day is allowed. The day is flagged on the dashboard and its worked time
counts in the month.

## Corrections

- An employee may correct their own session only while it is open or belongs to today's business
  date. Anything older goes through a Group admin (for a group member) or an Org admin (anyone).
- Every change, by a person or by the sweep, appends an attendance event. A null changing user is
  the sweep.
- No approval workflow: the admin is the authority.

## Location

- Off by default; an organization opts in. It is the employer's responsibility to agree this with
  its people; the product records nothing about that agreement.
- Coordinates come from the browser's own permission prompt at the clock-in and clock-out
  instants — never in the background, never through a custom prompt, never required. Declining is
  not recorded as a reason and not styled differently from any other missing value.
- Stored: latitude, longitude, accuracy. A session is created on click without coordinates; the
  first fix to arrive fills them, and a later one replaces it only when its accuracy is better.
  Either way only within two minutes of the instant the fix names. A fix that is late, no sharper,
  or aimed at a clock-out that has not happened yet is dropped without an error — the browser
  answers twice per click and neither answer is the person's problem.
- The person is told once, on the widget, that the organization records this; dismissing the notice
  is a per-user setting and it never comes back.
- Coordinates are nulled by the retention sweep once the business date is strictly more than twelve
  months old, so a session dated exactly twelve months back still carries them. The sweep shares the
  nightly tick with the attachment sweep. The session stays.

## Plan

`attendanceEnabled` is a stored organization setting; attendance is _active_ only while the
organization's live entitlement is `PRO` or `ENTERPRISE`. When the plan lapses, clock-in is refused
with a plain message and history stays readable. No cap on Employments per plan.

## Visibility

| Viewer      | Sees                                    |
| ----------- | --------------------------------------- |
| Employee    | their own Employment                    |
| Group admin | the Employments of that group's members |
| Org admin   | every Employment in the organization    |

A manager's own attendance is visible only to Org admins. An Employment in no group is visible only
to Org admins. Edit rights follow the same lines.
