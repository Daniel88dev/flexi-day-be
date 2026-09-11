# Attendance is org-scoped, through an explicit Employment row

Attendance (designed in Daniel88dev/flexi-day-workspace#11) is the first feature whose subject is a
person rather than a person-in-a-group. Vacation is `(user, group, day)` on purpose, billing is
priced per group, and nothing stores who belongs to an organization: that set is the union of the
owner, the delegated admins, every group's manager and every group's members, which the billing
rollup sums per group and double-counts. We chose to add an `employments` table, one row per
person per organization, and make it the subject of every attendance session, setting and
permission. It is backfilled once from that union and written on every path that joins someone to
an organization.

The alternatives were keying attendance on `group_users` and deriving the org's people with the
union query at read time. Keying on the group fails on the first person in two groups, who clocks
in once, and on the manager, who holds no `group_users` row at all. The derived union is cheaper
now but has nowhere to put a start date, an end date, a contracted-hours override or a timezone,
so the next HR feature would add the table anyway and migrate attendance onto it. The trade is a
second membership concept beside groups, one that every join path has to keep in step, sitting
orthogonal to how the product is priced. Attendance therefore carries its own org-level timezone,
holiday country and working days rather than reading a group's, because a group's settings cannot
describe a person who is in two of them.

## What would reverse this

Deciding attendance should be a per-group feature after all, priced and scoped like vacation. The
`employments` table would stay as the roster the rest of HR needs; only the session's foreign key
would move.
