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
- A clocked session's instants are the server's, never the client's. An entered session is the
  one exception, and it says so for good (see below).
- `businessDate` is fixed at clock-in from the organization's timezone and never moves, so a session
  that crosses midnight belongs wholly to the day it started.
- A session left open past the organization's ceiling (default 16 h) is closed by the sweep at
  `startedAt + ceiling` and marked as auto-closed. The same applies to a break left open past its
  own ceiling, whose close is clamped to the session's so it cannot outlive it. Both show on the
  dashboard as needing correction, and neither blocks the next clock-in. The sweep shares the
  nightly tick with the retention ones and takes the same Employment lock a clock-out takes, so a
  person closing their own session always wins.
- A break still inside its ceiling when the sweep closes the session around it is counted to that
  close like any clock-out, and is **not** marked auto-closed: the flag means a break that ran past
  its own ceiling, which is the only one the employee has to correct. The sweep only looks at breaks
  inside a session that is still running — under a closed session nobody is on a break. A break that
  began _after_ the session's ceiling, in the window before the sweep ran, closes at its own start:
  the session still ends where the ceiling is, so the break collapses rather than ending before it
  began.
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

Mid-month, both modes measure the balance against the **working days already begun**, not against
the whole month: on the 11th, the days nobody has worked yet are not a shortfall. The full month's
required time is reported beside it, so the figure the month is heading for is still on the screen.
A business date later than today is reported with its required time, so the full month's figure is
still there, but it is kept out of the balance and carries none of its own.

## Excluded days

No attendance is owed on a business date that is:

- outside the Employment's own spell, before it began or after it ended;
- not one of the organization's `workingDays`;
- a public holiday for the organization's `holidayCountry`;
- covered by a live, approved absence of type `VACATION`, `SICK`, `SICK_DAY`, `PAID_TIME_OFF`,
  `NON_PAID_LEAVE`, `STUDY_LEAVE` or `OTHER`, in any group of the organization.

They rank in that order, so a date says the bluntest true thing about itself: somebody who joined
on the 15th is told the 1st was not theirs to work rather than that it was a Tuesday off.

Approved means the calendar feed's predicate — not cancelled, not rejected, approved — which is
stricter than the glossary's Live row: a booking still waiting for its approver excuses nobody from
being at work. A mirrored record is a read-side projection of another group's row and never counts
on its own; the row it projects already counts wherever its own group belongs to the organization.

`HOME_OFFICE` does not exclude a day: working from home is working. A `halfDay` record halves the
required time for that day rather than excluding it, and half a day off is not one of the month's
days off. A half day landing on a day nobody works changes nothing: the day is already gone.

A date outside the spell owes nothing, carries no balance, and is left out of the month's count of
days off — it is not a day somebody was excused from.

The organization carries its own timezone, holiday country and working days for attendance. A
group's settings are never read, because an Employment is not group-shaped. Holidays resolve
through the stored table and its lazy fill, so the first ask for a year computes and keeps it.

Clocking in on an excluded day is allowed. The day is flagged on the dashboard and its worked time
counts in the month.

## Self-service window

An Org admin decides whether employees may enter and correct their own attendance, and how far
back. Group admins cannot change it; the window is organization-wide, like the Employment it
applies to.

| Setting      | What the employee may do by hand                                             |
| ------------ | ---------------------------------------------------------------------------- |
| Off          | Nothing. Clock in and out, start and end breaks; every correction is admin's |
| On, N days   | Today and the N calendar days before it, in the organization's timezone      |
| On, no limit | Any business date inside their own spell                                     |

N runs from 0 to 366, and 0 means today only. While the window is on, a session still open counts as
inside it whatever its date, so a session running past midnight stays its owner's to fix. A new
organization starts with the window off. Organizations that had attendance before the window existed
start at on, 0 days, which is the rule they already had.

Inside the window the employee may enter a session, add a break, correct either, and delete a
break. They may delete only sessions they entered themselves: a clocked session from a past day can
be corrected but never removed by its owner, so a real clock-in cannot vanish at their hand.
Outside the window, and always for an ended Employment, only a Group admin (for a group member) or
an Org admin (anyone) can write, and the refusal says so rather than reading as a bare "no".

Changing the setting affects later writes only. Narrowing it or switching it off undoes nothing
already written and flags nothing afresh.

## Entered sessions

A session recorded after the fact rather than clocked, by an admin for anyone they can see, or by
the employee inside their window.

- The person names the business date and both ends. The start falls on that date in the
  organization's timezone; the end may cross midnight. The session is closed and wholly in the
  past: "I forgot to clock in and I'm still here" is a clock-in now and a correction of its start,
  which needs an admin when the window is off.
- It obeys every rule a corrected session does: end after start, within the session ceiling, inside
  the Employment's spell, and no overlap with another session.
- An excluded day is allowed, as a clock-in on one is, and flagged the same way.
- It carries no location fix.
- It is marked as entered for good, whoever entered it, and its first attendance event records
  that it was entered and by whom. Clocked sessions keep the promise that their times are the
  server's.

A break can be added to any closed session under the same rights, inside the entry or afterwards.
It must sit inside its session and not overlap another break.

## Corrections

- Who may change a session is the self-service window's question, above.
- Every change, by a person or by the sweep, appends an attendance event. A null changing user is
  the sweep. That includes entering a session and adding a break.
- A session the employee changed after its business date, by editing it or by adding, moving or
  removing one of its breaks, is flagged on the dashboard until an admin corrects it, the same way
  a swept session is. A session they entered carries the entered mark instead.
- Every change to the attendance settings is logged with who made it, when, and the values before
  and after. Nothing in the product reads the log back; it answers "when was the window open, and
  who opened it".
- No approval workflow: the admin is the authority.
- A correction moves times, never days. `businessDate` is fixed at clock-in and is not recomputed
  from a corrected start, so an edit changes what a day holds rather than which day holds it.
- Correcting a clock-out records who closed the session, which is how a swept session stops being
  flagged; correcting a break's end clears its auto-closed flag for the same reason. Moving only a
  clock-in leaves both alone — nobody has looked at the end yet.
- A session must end after it starts and hold its breaks inside itself; the open-session and
  open-break indexes still hold, so an edit that would reopen one while another is open is refused
  rather than silently losing the race. Two sessions of one Employment may not cover the same
  minutes either — nothing but a correction can make that shape, and presence would count them
  twice. Back to back is fine: a session may end exactly where the next one starts.
- Deleting a session is soft: the row, its breaks and its whole timeline stay, every read filters
  it out, and the clock is free again because the open-session index ignores deleted rows.
  Deleting a break is not soft — the event that records what it was is all that is left of it.
- Reading a session's timeline follows the visibility table rather than the window: an employee
  reads their own history however old it is, and only changing it needs the window.
- Corrections, entered sessions and added breaks are writes, so the plan gate applies: a lapsed
  organization's history is readable and not editable. An ended Employment is the exception a
  clock-in is not — an admin may still fix it, because its last day is the one most likely to need
  fixing.

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
  nightly tick with the attachment sweep. The session stays, and so does its attendance event — but
  the event's `before` and `after` are stripped of the same three keys on the same pass, or the
  audit trail would outlive the promise the session columns keep.

## Plan

`attendanceEnabled` is a stored organization setting; attendance is _active_ only while the
organization's live entitlement is `PRO` or `ENTERPRISE`. When the plan lapses, or when an admin
switches attendance off, the clock **refuses to open and still lets a person close**: clock-in and
break-start are refused with a plain message, clock-out and break-end go through, and history stays
readable. Anything else would strand whoever was clocked in at that moment — the sweep would close
their day at its ceiling and flag it, and corrections are gated too, so nobody could put it right
until the organization paid again. Corrections stay gated: a lapsed organization can finish the day
it started, not rewrite it. No cap on Employments per plan.

## Visibility

| Viewer      | Sees                                    |
| ----------- | --------------------------------------- |
| Employee    | their own Employment                    |
| Group admin | the Employments of that group's members |
| Org admin   | every Employment in the organization    |

A manager's own attendance is visible only to Org admins. An Employment in no group is visible only
to Org admins. Edit rights follow the same lines.
