# better-auth 1.7 migration runbook

One-off. Delete this file once production is on 1.7.

better-auth 1.7 stops keying an account by `providerId` and keys it by
`(issuer, accountId)` instead. That adds a `NOT NULL` column to a table the auth
code reads on every sign-in, which is why this upgrade needs a window rather
than an ordinary deploy. Upstream guide:
<https://better-auth.com/docs/guides/1-7-upgrade-guide>.

## Why a window is unavoidable

CD promotes the moving tag on every push to `main` and App Runner pulls it
automatically, while `db:migrate:prod` is run by hand from a terminal. Neither
order is safe on its own:

- **Code first.** The drizzle adapter selects an explicit column list that now
  contains `issuer`. Against an un-migrated database every account read is
  `column account.issuer does not exist` — email sign-in, the social callback,
  list-accounts and password reset all 500.
- **Migration first.** The still-running 1.6 image writes account rows without
  `issuer`, so every sign-up and every `/link-social` fails on a not-null
  violation.

Sessions already issued keep working throughout — `customSession` does not read
the account table. What is down is the entry surface: signing in, signing up,
linking, and password reset.

**This deploy is one-way.** Once `issuer` is `NOT NULL`, rolling the image back
to 1.6 breaks every account write, because 1.6 does not know to populate it. The
snapshot from step 3 is the only rollback.

## Sequence

App Runner is the trap here. `terraform/apprunner.tf` sets `min_size = 1` and the
service floor is one instance, so there is no scaling to zero; and while
`auto_deployments_enabled = true`, **a paused service does not pick up images
pushed while it was paused** — resuming redeploys the version from before the
pause. CD only pushes to ECR (`.github/workflows/cd.yml` has no
`start-deployment`), so the 1.7 image needs an explicit push after resuming.
Follow the order below exactly.

1. Announce the window. Ten minutes; the table is small but step 4 is manual.
2. Get a psql on prod. `db:status:prod` only prints the ledger and
   `scripts/db-migrate.sh` never prints the connection string, so assemble it
   from Secrets Manager yourself — RDS is `publicly_accessible` — and export
   `PGHOST/PGUSER/PGPASSWORD/PGDATABASE` rather than passing a URL that `ps`
   would leak.
3. Run the pre-flight in the next section. Fix what it reports **before**
   pausing anything; every one of its failures aborts the migration.
4. `aws apprunner pause-service`. Take an RDS snapshot once it is paused — step
   6 rewrites keys and deletes rows, and this snapshot is the only rollback.
5. Merge the backend PR so CD builds and pushes the 1.7 image to ECR. It will
   not deploy while paused; that is expected.
6. `npm run db:migrate:prod`.
7. `aws apprunner resume-service`, then **`aws apprunner start-deployment`** —
   resume alone brings back 1.6, which would fail every account write against
   the new `NOT NULL` column.
8. Verify before reopening: `/health`, one real email sign-in, and one
   `list-accounts` on an account that had a Google link.
9. Merge the frontend PR. It only speaks the 1.7 shapes, so it goes after the
   backend is confirmed, never before.
10. Send the emails from the next section, then drop
    `account_issuer_migration_dropped`.

## Pre-flight

Read-only, run before the window. Each query maps to a way the migration aborts
or loses data.

```sql
-- 1. Every provider needs a rule. Anything outside credential/google/microsoft
--    stops the migration at "no mapping for provider_id".
SELECT provider_id, count(*) FROM account GROUP BY provider_id;

-- 2. Duplicates on the POST-backfill key, which is what guard 2 checks. Two
--    Microsoft rows with different `sub` can share an `oid`, and two credential
--    rows for one user collapse onto the same key once account_id is realigned,
--    so grouping on the current (provider_id, account_id) would miss both.
--    This mirrors the migration's own decode, including its error handling, so
--    the two cannot disagree. Prints nothing when there is nothing to fix.
DO $$
DECLARE r record; payload jsonb; segment text; k_iss text; k_acc text; found int := 0;
BEGIN
  CREATE TEMP TABLE preflight_keys (dup_issuer text, dup_account_id text) ON COMMIT DROP;
  FOR r IN SELECT provider_id, account_id, user_id, id_token FROM account LOOP
    IF r.provider_id = 'credential' THEN
      k_iss := 'local:credential'; k_acc := r.user_id;
    ELSIF r.provider_id = 'google' THEN
      k_iss := 'https://accounts.google.com'; k_acc := r.account_id;
    ELSE
      payload := NULL;
      segment := translate(split_part(coalesce(r.id_token, ''), '.', 2), '-_', '+/');
      IF length(segment) > 0 THEN
        BEGIN
          payload := convert_from(
            decode(rpad(segment, (length(segment) + 3) / 4 * 4, '='), 'base64'), 'UTF8')::jsonb;
        EXCEPTION WHEN others THEN payload := NULL;
        END;
      END IF;
      k_iss := payload ->> 'iss'; k_acc := payload ->> 'oid';
    END IF;
    IF k_iss IS NOT NULL AND k_acc IS NOT NULL THEN
      INSERT INTO preflight_keys VALUES (k_iss, k_acc);
    END IF;
  END LOOP;

  FOR r IN SELECT dup_issuer, dup_account_id, count(*) AS n FROM preflight_keys
           GROUP BY 1, 2 HAVING count(*) > 1 LOOP
    found := found + 1;
    RAISE NOTICE 'DUPLICATE KEY: % / % appears % times', r.dup_issuer, r.dup_account_id, r.n;
  END LOOP;
  IF found = 0 THEN RAISE NOTICE 'no duplicate keys - guard 2 will pass'; END IF;
END $$;

-- 3. Credential rows the migration will realign. Informational, but a non-zero
--    count means query 2 above is the one that matters.
SELECT count(*) FROM account WHERE provider_id = 'credential' AND account_id <> user_id;
```

Resolve any row query 2 returns by hand before the window. Add an `UPDATE` to
`0001_account_issuer.sql` for any provider query 1 turns up — do not improvise
in psql during the outage.

## What the backfill does to each provider

| `provider_id` | `issuer`                      | `account_id`                | outcome                       |
| ------------- | ----------------------------- | --------------------------- | ----------------------------- |
| `credential`  | `local:credential`            | realigned to the user id    | preserved                     |
| `google`      | `https://accounts.google.com` | unchanged — still `sub`     | preserved                     |
| `microsoft`   | `iss` claim from `id_token`   | `oid` claim from `id_token` | preserved, re-keyed           |
| `microsoft`   | — (no decodable `id_token`)   | —                           | **row deleted**, must re-link |

Microsoft moves both halves of its key: 1.6 stored `account_id` as the pairwise
`sub`, and 1.7 looks the account up by the directory `oid` under the tenant's own
`iss`. Both claims are in the `id_token` better-auth already stored verbatim —
only access and refresh tokens are passed through `setTokenUtil`, and this app
sets no `advanced.encryptOAuthTokens` — and 1.6's Microsoft provider refused to
create an account without one, so in practice every row can be re-keyed.

A row whose token is missing or undecodable has no recoverable key, and is
deleted rather than left behind: a stale row strands the user on
`account not linked`, because the lookup misses and `disableImplicitLinking`
refuses the implicit re-link at sign-in. Deleting makes the settings card say
"Not connected", which is true.

**Recovery for anyone in that last row is password reset, not re-linking.**
Re-linking goes through `/link-social`, which needs a session they cannot get.
Password reset works even for a user who never had a password: the request does
not require a credential account, and completing it creates one. Tell affected
users that, and do not tell them to "just reconnect".

The migration writes every dropped link to `account_issuer_migration_dropped`
before deleting it, so the list is exact and survives the window — a
`RAISE NOTICE` would not, since `drizzle-kit migrate` installs no notice
listener on the pg client. After step 8:

```sql
SELECT email, legacy_account_id, reason FROM account_issuer_migration_dropped
ORDER BY email;
```

`reason` distinguishes the three cases the migration cannot recover from: no
`id_token` stored, a payload that did not decode, and a payload without `iss`
or `oid`. Drop the table once the emails are out.

## Afterwards

`src/tests/db/accountIssuer.test.ts` pins both halves of every provider's key —
the issuer literals in the SQL and the subject claim each provider resolves — to
better-auth's own declarations, so a later upgrade that changes either one fails
a test instead of quietly stranding accounts.
