ALTER TABLE "group_users" ADD COLUMN "approver_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: whoever could already approve for a group keeps that right.
UPDATE "group_users" AS gu
SET "approver_access" = true
FROM "groups" AS g
WHERE g."id" = gu."group_id"
  AND gu."deleted_at" IS NULL
  AND g."deleted_at" IS NULL
  AND gu."user_id" IN (g."manager_user_id", g."main_approval_user", g."temp_approval_user");
