-- better-auth 1.7 keys an account by (issuer, accountId) instead of by provider.
-- Backfill follows the mapping in https://better-auth.com/docs/guides/1-7-upgrade-guide:
-- an OIDC provider contributes its own trusted issuer, everything else gets a
-- synthetic one. Nullable first so the backfill has somewhere to land.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint

UPDATE "account" SET "issuer" = 'local:credential' WHERE "provider_id" = 'credential';--> statement-breakpoint

-- 1.7 resolves a password sign-in by all three of providerId, issuer and
-- accountId = the user's own id (sign-in.mjs). Sign-up has always written the
-- user id here, so this is a no-op on healthy data, but a row that drifted
-- would stop matching and cost that user password sign-in with no error to
-- explain it. Realigning costs nothing and cannot collide: user_id is unique
-- per user, and two credential rows for one user trip the guard below.
UPDATE "account" SET "account_id" = "user_id"
WHERE "provider_id" = 'credential' AND "account_id" <> "user_id";--> statement-breakpoint

-- Google's subject is still the `sub` claim in 1.7, so only the issuer is new
-- and these rows survive intact. The literal is Google's OIDC issuer, pinned to
-- better-auth's own provider declaration by accountIssuer.test.ts.
UPDATE "account" SET "issuer" = 'https://accounts.google.com' WHERE "provider_id" = 'google';--> statement-breakpoint

-- A dropped link is a person who has to be told, so the migration records them
-- rather than announcing a count. `drizzle-kit migrate` installs no `notice`
-- listener on the pg client, so a RAISE NOTICE here would go nowhere. This
-- table is deliberately outside the drizzle schema: it is operational, read
-- after the window to send the emails, then dropped by hand.
CREATE TABLE IF NOT EXISTS "account_issuer_migration_dropped" (
  "user_id" text NOT NULL,
  "email" text,
  "provider_id" text NOT NULL,
  "legacy_account_id" text,
  "reason" text NOT NULL,
  "dropped_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Microsoft changed both halves of the key: 1.6 stored `account_id` as the
-- pairwise `sub`, 1.7 looks the account up by the directory `oid` under the
-- tenant's own `iss`. Both live in the id_token better-auth already persisted
-- verbatim — only access and refresh tokens go through `setTokenUtil`, and
-- this app sets no `advanced.encryptOAuthTokens` — and 1.6's Microsoft
-- provider refused to create an account at all without one, so every row here
-- has the claims needed to re-key it. A row whose token is missing or
-- undecodable has no recoverable key and is dropped for a re-link instead;
-- leaving it would strand the user on `account not linked` with nothing to
-- click, since `disableImplicitLinking` refuses the implicit re-link.
DO $$
DECLARE
  r record;
  payload jsonb;
  claim_iss text;
  claim_oid text;
  segment text;
  rekeyed int := 0;
  dropped int := 0;
BEGIN
  FOR r IN SELECT "id", "id_token" FROM "account" WHERE "provider_id" = 'microsoft' LOOP
    payload := NULL;
    segment := translate(split_part(coalesce(r."id_token", ''), '.', 2), '-_', '+/');
    IF length(segment) > 0 THEN
      BEGIN
        payload := convert_from(
          decode(rpad(segment, (length(segment) + 3) / 4 * 4, '='), 'base64'), 'UTF8'
        )::jsonb;
      EXCEPTION WHEN others THEN
        payload := NULL;
      END;
    END IF;

    claim_iss := payload ->> 'iss';
    claim_oid := payload ->> 'oid';

    IF claim_iss IS NOT NULL AND claim_oid IS NOT NULL THEN
      UPDATE "account" SET "issuer" = claim_iss, "account_id" = claim_oid WHERE "id" = r."id";
      rekeyed := rekeyed + 1;
    ELSE
      INSERT INTO "account_issuer_migration_dropped"
        ("user_id", "email", "provider_id", "legacy_account_id", "reason")
      SELECT a."user_id", u."email", a."provider_id", a."account_id",
             CASE WHEN r."id_token" IS NULL THEN 'no id_token stored'
                  WHEN payload IS NULL THEN 'id_token payload did not decode'
                  ELSE 'id_token payload lacks iss or oid' END
      FROM "account" a LEFT JOIN "user" u ON u."id" = a."user_id"
      WHERE a."id" = r."id";

      DELETE FROM "account" WHERE "id" = r."id";
      dropped := dropped + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'microsoft: % re-keyed from id_token, % dropped with no usable token', rekeyed, dropped;
END $$;--> statement-breakpoint

-- Any provider added between this file being written and being applied would
-- reach here unmapped. Fail loudly rather than invent an issuer for it.
DO $$
DECLARE unmapped text;
BEGIN
  SELECT string_agg(DISTINCT "provider_id", ', ') INTO unmapped
  FROM "account" WHERE "issuer" IS NULL;
  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION 'account.issuer backfill has no mapping for provider_id: %', unmapped;
  END IF;
END $$;--> statement-breakpoint

-- The guide's collision check. The unique index below would fail on its own,
-- but this names the offending rows instead of just the constraint.
DO $$
DECLARE collisions text;
BEGIN
  SELECT string_agg(format('%s/%s x%s', "issuer", "account_id", cnt), '; ') INTO collisions
  FROM (
    SELECT "issuer", "account_id", COUNT(*) AS cnt
    FROM "account" GROUP BY "issuer", "account_id" HAVING COUNT(*) > 1
  ) dupes;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate (issuer, account_id) rows block the unique index: %', collisions;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_issuer_account_id" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id");
