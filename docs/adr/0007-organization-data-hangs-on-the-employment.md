# Organization data hangs on the Employment; a deleted account leaves a stripped user row

Flexi Day controls account data and processes organization data for the employer (decided on
fenro T-481). Account deletion used to hard-delete the user, and every booking, quota, change log
entry, membership, Employment and attendance session cascaded away with it. The employer, who
controls those records, lost them on someone else's instruction.

We keep the organization's records and let the account go. The user row stays as a **Deleted
account**: only the id is left, with an empty name, the placeholder email `<id>@deleted.invalid`,
no picture and `deleted_at` set, and no session is ever created for it. Bookings, quotas, the
change log and memberships stay keyed to that id, so every foreign key and every reader keeps
working without a change. The Employment carries the organization's own copy of the name and
email, frozen at the deletion and stamped with `account_deleted_at`, and one helper, `personName`,
reads that copy wherever the account's name used to show. Account data (sessions, provider links,
settings, notifications, calendar links, Birthday) is deleted outright. ADR 0004 made the
Employment the person's membership in an organization; this makes it the thing organization data
is about.

The alternative was to re-key bookings, quotas, changes, memberships and mirrors onto the
Employment and delete the user row. It is the cleaner model: no placeholder row, no `deleted_at`
on the auth table, no name helper falling back across tables. But it touches every table and
reader that holds a user id, which is one or two build tickets more, and it would have held up
the deletion change, which ships first. The cost of the stripped row is that the auth schema now
holds rows that are not accounts, so `user.name` alone can no longer be trusted for display, and
the name and email columns hold placeholders because they stay NOT NULL and unique.

The row stays for good, even after an admin erases the person's organization data. Deleting it
would need new `ON DELETE` rules for `groups.manager_user_id`, the approver slots,
`changes.changing_user_id` and `support_access`.

## What would reverse this

Re-keying organization data onto the Employment. Once every booking, quota, change and membership
points at an Employment rather than a user, the user row could go with the account, and
`personName` would read the Employment directly.
