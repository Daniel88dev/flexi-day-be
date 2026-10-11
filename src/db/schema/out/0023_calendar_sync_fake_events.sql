CREATE TABLE "calendar_sync_fake_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"operation" text NOT NULL,
	"provider_event_id" text,
	"payload" jsonb,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_sync_fake_events" ADD CONSTRAINT "calendar_sync_fake_events_connection_id_calendar_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_fake_events_connection" ON "calendar_sync_fake_events" USING btree ("connection_id");