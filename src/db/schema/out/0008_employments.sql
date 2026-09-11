CREATE TABLE "employments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"required_minutes_per_day" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_employments_organization_id_user_id" ON "employments" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_employments_user_id" ON "employments" USING btree ("user_id");--> statement-breakpoint
-- One-time roster backfill: an Employment for everyone currently reachable
-- from an organization, stamped with their oldest link rather than now. The
-- only copy of this statement — `employmentRoster.e2e.test.ts` reads it out of
-- this file and runs it, so the assertions there are against what production
-- ran rather than a tidier twin.
INSERT INTO "employments" ("id", "organization_id", "user_id", "started_at")
SELECT gen_random_uuid()::text, link.organization_id, link.user_id, MIN(link.linked_at)
FROM (
  SELECT "id" AS organization_id, "owner_user_id" AS user_id, "created_at" AS linked_at
    FROM "organizations"
  UNION ALL
  SELECT "organization_id", "user_id", "created_at"
    FROM "organization_users" WHERE "deleted_at" IS NULL
  UNION ALL
  SELECT "organization_id", "manager_user_id", "created_at"
    FROM "groups" WHERE "deleted_at" IS NULL
  UNION ALL
  SELECT g."organization_id", gu."user_id", gu."created_at"
    FROM "group_users" gu
    JOIN "groups" g ON g."id" = gu."group_id"
   WHERE gu."deleted_at" IS NULL AND g."deleted_at" IS NULL
) AS link
GROUP BY link.organization_id, link.user_id
ON CONFLICT ("organization_id", "user_id") DO NOTHING;
