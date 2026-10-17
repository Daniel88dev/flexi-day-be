ALTER TYPE "public"."calendar_sync_event_kind" ADD VALUE 'GROUP_EVENT';--> statement-breakpoint
ALTER TYPE "public"."calendar_sync_event_kind" ADD VALUE 'BIRTHDAY';--> statement-breakpoint
-- One zone per config serves the .ics feed and the sync target. The default also keeps an image
-- that predates this migration creating configs while it is already applied.
ALTER TABLE "calendar_sync" ALTER COLUMN "time_zone" SET DEFAULT 'Europe/Prague';--> statement-breakpoint
UPDATE "calendar_sync" SET "time_zone" = 'Europe/Prague' WHERE "time_zone" IS NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync" ALTER COLUMN "time_zone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "include_group_events" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "group_events_color" text;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "include_birthdays" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "birthdays_color" text;--> statement-breakpoint
-- The ledger is keyed by source from here on. Every existing row is a vacation's. A row whose
-- vacation was hard-deleted has no vacation id left; its key only has to stay unique, because the
-- next sync deletes it at the provider.
ALTER TABLE "calendar_sync_events" ADD COLUMN "source_key" text;--> statement-breakpoint
UPDATE "calendar_sync_events"
SET "source_key" = CASE
  WHEN "vacation_id" IS NOT NULL THEN 'v:' || "vacation_id"
  ELSE 'orphan:' || "id"
END;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ALTER COLUMN "source_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD COLUMN "group_event_id" text;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD COLUMN "birthday_user_id" text;--> statement-breakpoint
DROP INDEX "calendar_sync_events_config_vacation_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_events_config_source_uniq" ON "calendar_sync_events" USING btree ("calendar_sync_id","source_key");
