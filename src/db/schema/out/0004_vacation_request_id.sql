-- Every day row carries the id of the Request it was submitted in. Existing rows
-- are grouped by user, group and creation timestamp: bulk creation inserts a
-- whole request in one statement, so its rows share one created_at.
ALTER TABLE "vacation" ADD COLUMN "request_id" text;--> statement-breakpoint
-- MATERIALIZED pins one evaluation of gen_random_uuid() per group. As a plain
-- subquery the planner may rescan it per updated row, handing every row of a
-- range its own id.
WITH r AS MATERIALIZED (
  SELECT "user_id", "group_id", "created_at", gen_random_uuid()::text AS "request_id"
  FROM "vacation"
  GROUP BY "user_id", "group_id", "created_at"
)
UPDATE "vacation" AS v
SET "request_id" = r."request_id"
FROM r
WHERE v."user_id" = r."user_id"
  AND v."group_id" = r."group_id"
  AND v."created_at" = r."created_at";--> statement-breakpoint
ALTER TABLE "vacation" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
-- The default keeps an image that predates the column inserting while the
-- migration is already applied. The API always supplies its own id.
ALTER TABLE "vacation" ALTER COLUMN "request_id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
CREATE INDEX "vacation_request_id_idx" ON "vacation" USING btree ("request_id");
