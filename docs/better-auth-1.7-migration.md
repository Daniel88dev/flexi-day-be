# better-auth 1.7 account key runbook

One-off, in two parts. Part one is the record of what production already ran.
Part two is the revert, which is the work still outstanding. Delete the file
once part two is done and `account_issuer_migration_dropped` is gone.

## Part one: what production ran

better-auth 1.7.0 stopped keying an account by `providerId` and keyed it by
`(issuer, accountId)` instead. `0001_account_issuer.sql` moved production onto
that key in one window, and it did two separate things:

1. Added the `issuer` column, backfilled it per provider, then set `NOT NULL`
   and created `idx_account_issuer_account_id`.
2. Re-keyed Microsoft `account_id` from the pairwise `sub` to the directory
   `oid`, decoded out of the `id_token` better-auth had already stored.

| `provider_id` | `issuer` written              | `account_id`                | outcome                       |
| ------------- | ----------------------------- | --------------------------- | ----------------------------- |
| `credential`  | `local:credential`            | realigned to the user id    | preserved                     |
| `google`      | `https://accounts.google.com` | unchanged, still `sub`      | preserved                     |
| `microsoft`   | `iss` claim from `id_token`   | `oid` claim from `id_token` | preserved, re-keyed           |
| `microsoft`   | none decodable                | none                        | **row deleted**, must re-link |

Rows in that last case went into `account_issuer_migration_dropped` before they
were deleted, because `drizzle-kit migrate` installs no notice listener and a
`RAISE NOTICE` would have gone nowhere. That table is outside the drizzle schema
on purpose, and it is read and dropped by hand. See the loose end below.

## Part two: the revert to 1.7.4

better-auth 1.7.3 ([better-auth#11153](https://github.com/better-auth/better-auth/pull/11153))
restored the 1.6 key. An account is identified by `(providerId, accountId)`
again, `issuer` is gone from the core account schema, and
`createLocalAccountIssuer` / `createOAuthAccountIssuer` no longer exist. The
lockfile is what held this repo at 1.7.2 to stay compiling; `package.json`
carried a caret, which already permits 1.7.4. The column production ran has to
come back out.

**Upstream reverted only the first half of `0001`.** `@better-auth/core` 1.7.4
still declares `accountSubject: ({ profile }) => profile.oid` for Microsoft and
`profile.sub` for Google, byte for byte what 1.7.2 declared, and the credential
path in `dist/api/routes/sign-in.mjs` dropped its `account.issuer` clause while
keeping `account.accountId === user.id`. So every `account_id` value `0001`
wrote is what 1.7.4 looks up. **Keep the Microsoft `oid` re-key. Undoing it is
the one change that would break sign-in.** Drop only the column and its unique
index. No row's data changes, so there is no backfill.

### Why the column cannot just stay

1.7.3 and later run a schema check at init that throws rather than warns
(`@better-auth/core/dist/db/schema-check.mjs`:
`if (findings.length) throw new SchemaMismatchError(findings, source)`). A
required column better-auth never writes raises `unexpected-required-column`,
and the hint names this exact case: every insert into `account` would fail. The
check reads the Drizzle schema as well as the database, so both sides move.

### Why there is no window this time

`schema-diff.mjs` skips any column that is nullable or has a default:

```js
if (written.has(column.name) || column.nullable || column.hasDefault) continue;
```

A **nullable** `issuer` offends neither image. 1.7.2 carries on writing it and
1.7.4 ignores it, so that one state is an overlap wide enough to deploy
through, which is what `0001` never had. Postgres treats NULLs as distinct in a
unique index, so rows 1.7.4 writes with `issuer IS NULL` do not collide under
the old index either.

This is an ordinary deploy. No `apprunner pause-service`, no
`start-deployment`, no announced window.

### Sequence

The split into two migration files is the zero-downtime property, so they get
applied at two different moments rather than in one run. `drizzle-kit generate`
would have emitted a single drop, which is why both are hand-written the way
`0001` was.

`db:migrate:prod` applies everything the journal lists and has no flag to stop
at one file, so **what separates the two steps is which commit you run it
from.** The branch carries two commits for exactly that reason:

| Commit     | Journal ends at | better-auth | `account.issuer` |
| ---------- | --------------- | ----------- | ---------------- |
| `8fe3d6f`  | `0006`          | 1.7.2       | nullable         |
| branch tip | `0007`          | 1.7.4       | dropped          |

Before anything, run `npm run db:status:prod`. If the ledger still holds the
pre-squash entries rather than one row for `0000_init`, `npm run db:baseline:prod`
has to come first, or drizzle replays the whole baseline over the live schema.

1. **Migration A, before the deploy.** Check out the first commit and migrate.
   Its journal ends at `0006`, so that is all that runs:

   ```bash
   git checkout 8fe3d6f
   npm run db:migrate:prod
   ```

   No `npm ci` first. The migrate script only uses `drizzle-orm` and `pg`, so
   whichever better-auth is installed does not matter. Come back with
   `git checkout feat/better-auth-1-7-4`.

   The column is nullable now and 1.7.2 carries on writing it. Nothing is down.

2. **Merge the PR and let CD deploy.** Ordinary deploy, no pause, no
   `start-deployment`. If it has to be rolled back, 1.7.2 still runs against a
   nullable column.

3. **Migration B, once the deploy is confirmed.** From `main`:

   ```bash
   npm run db:migrate:prod
   ```

   The newest ledger row is `0006`, so only `0007` runs.

   `0007` checks for itself that no two rows share `(provider_id, account_id)`
   before it drops anything, because that pair carries uniqueness alone
   afterwards. Two Microsoft rows in different tenants sharing an `oid` are the
   only way it collides, which is vanishingly unlikely for a GUID. If it does,
   the migration aborts naming the offending row and commits nothing, since
   drizzle wraps the whole run in one transaction.

4. **Verify.** `/health`, one email sign-in, one `list-accounts` on an account
   with a Google link, and a returning **Microsoft** sign-in. Microsoft is the
   one that proves the `oid` key survived; the others would look fine either
   way.

### Loose end

`account_issuer_migration_dropped` still exists. Nothing above needs it, and
none of the steps above need a psql session, so this is the one piece that
does. It does not block the migration and can wait. If the table holds rows,
those users lost a Microsoft link during the 1.7.0 migration and were never
told:

```sql
SELECT email, legacy_account_id, reason FROM account_issuer_migration_dropped
ORDER BY email;
```

**Recovery for anyone on that list is password reset, not re-linking.**
`/link-social` needs a session they cannot get. Password reset works even for a
user who never had a password: the request does not require a credential
account, and completing it creates one. Drop the table once the emails are out.

### What still guards the key

`src/tests/db/accountSubject.test.ts` replaces the old `accountIssuer` test. The
issuer literals it pinned no longer exist upstream, but the Microsoft `oid`
re-key is now the load-bearing half of `0001` on its own, so the test pins
`socialProviders.microsoft(...).accountSubject` against the claim `0001` wrote.
A future release that moves the subject back fails that test instead of quietly
locking every Microsoft user out.
