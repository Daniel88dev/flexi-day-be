-- Step one of dropping `issuer` without a maintenance window.
-- better-auth's schema check skips a nullable column, so this single state runs
-- under both images: 1.7.2 keeps writing the column, 1.7.4 ignores it. Apply
-- this before the 1.7.4 deploy; 0007 drops the column once the deploy is
-- confirmed (docs/better-auth-1.7-migration.md).
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
