ALTER TYPE "public"."vacation_event_type" ADD VALUE 'UPDATED';--> statement-breakpoint
ALTER TABLE "vacation" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "vacation" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_deleted_by_user_id_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "vacation" SET "created_by_user_id" = "user_id" WHERE "created_by_user_id" IS NULL;--> statement-breakpoint
UPDATE "vacation" v SET "deleted_by_user_id" = (
  SELECT e."actor_user_id" FROM "vacation_events" e
  WHERE e."vacation_id" = v."id" AND e."event_type" = 'CANCELLED'
  ORDER BY e."created_at" DESC LIMIT 1
) WHERE v."deleted_at" IS NOT NULL AND v."deleted_by_user_id" IS NULL;