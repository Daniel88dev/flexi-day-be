-- Step two. Only safe once every instance is on better-auth 1.7.4, which keys
-- an account by (provider_id, account_id) again.
-- `account_issuer_migration_dropped` is deliberately left alone: 0001 wrote the
-- users who lost a Microsoft link into it, and it is read and dropped by hand.

-- Dropping issuer from the key leaves (provider_id, account_id) carrying
-- uniqueness alone. Two Microsoft rows in different tenants sharing an `oid`
-- are the only way that collides. CREATE UNIQUE INDEX below would catch it, but
-- name the offending row rather than making someone read a duplicate-key error
-- against an index that no longer exists by the time they look.
DO $$
DECLARE dup record;
BEGIN
  SELECT "provider_id", "account_id", count(*) AS n INTO dup
  FROM "account" GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'account has % rows sharing (provider_id, account_id) = (%, %); resolve them before dropping issuer',
      dup.n, dup."provider_id", dup."account_id";
  END IF;
END $$;--> statement-breakpoint

-- The index goes before the column it covers, per the upstream upgrade guide.
DROP INDEX "idx_account_issuer_account_id";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_provider_id_account_id" ON "account" USING btree ("provider_id","account_id");
