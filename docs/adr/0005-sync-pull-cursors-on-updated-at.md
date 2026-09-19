# The sync pull's cursor is an `updatedAt` high-water mark, not a change log

The sync pull (`GET /api/sync/pull`, specified in Daniel88dev/flexi-day-be#182) answers every row
the caller may see that changed since their last pull. Deciding what "since" means was the whole
design. We chose the cheapest thing the schema already carries: the cursor is a position on
`updatedAt`, and a delta returns the rows whose `updatedAt` is later than that position less a 60
second overlap and no later than the position the pull was minted with. Nothing was added to the
database for it. The cursor itself is a server-minted opaque string, base64url JSON carrying a
version, that the client stores verbatim and never parses.
[`docs/sync-pull.md`](../sync-pull.md) holds the rules that follow from it.

The alternatives were a change log table and a monotonic sequence column. Either answers "since"
exactly, without an overlap and without a row ever arriving twice, and a sequence column would
have made hard deletes expressible too. Both cost the same thing: a migration across the six tables
the pull reads for changes (`user`, `groups`, `group_users`, `group_mirrors`, `user_year_quotas`,
`vacation`), and a change to every write path that touches them, including the seven
vacation transitions, the quota rollover job and the lazy bank-holiday fill. A write that forgot
to bump the sequence or append to the log would go missing from every client's copy, silently, and
the pull had no traffic yet to justify that. The opaque cursor is what keeps the option open: its
encoding is versioned, so a later switch to a sequence changes the codec and the readers, mints
version 2, and every client holding a version 1 cursor answers one sync reset and carries on. No
client release is involved.

Three costs came out of the implementation and we accept them. The 60 second overlap means a row
can arrive twice, because inserts are stamped by the database and updates by whichever App Runner
instance ran them, so a narrower window would lose a row committed by a clock that lags; clients
upsert, and the second delivery changes nothing. A table with no `deletedAt` column cannot tombstone
a row at all, `user`, `user_year_quotas` and `bank_holidays` among them, so a person who left, a
quota that was removed or a holiday that fell out of the window lingers on the device until the 30
day cursor
expiry forces a snapshot and the client sweeps what it did not get back. And a high-water mark
cannot express a change in what the caller may see: joining a group, losing a flag or a mirror
appearing changes the visible set without changing the rows that were already visible. That is why
the four reset triggers exist, and why a scope change answers a full snapshot rather than a delta.

## What would reverse this

A table joining the pull that has no `updatedAt` to key on, `vacation_events` and the request
timeline being the obvious candidates, or the 30 day expiry becoming the wrong answer to hard
deletes because a snapshot has grown too expensive to send. Either is a reason to add the change
log and mint a cursor version that reads from it. The endpoint, the envelope and the client's apply
loop stay as they are; only the codec and the readers move.
