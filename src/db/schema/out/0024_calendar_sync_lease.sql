ALTER TABLE "calendar_connection" ADD COLUMN "sync_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD COLUMN "event_type" text;