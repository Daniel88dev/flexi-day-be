CREATE TYPE "public"."calendar_capability" AS ENUM('UNKNOWN', 'STATUS', 'PLAIN');--> statement-breakpoint
CREATE TYPE "public"."calendar_connection_status" AS ENUM('ACTIVE', 'NEEDS_RECONNECT');--> statement-breakpoint
CREATE TYPE "public"."calendar_provider" AS ENUM('GOOGLE', 'MICROSOFT');--> statement-breakpoint
CREATE TYPE "public"."calendar_sync_event_kind" AS ENUM('ABSENCE', 'HOME_OFFICE');--> statement-breakpoint
CREATE TABLE "calendar_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"granted_scopes" text NOT NULL,
	"capability" "calendar_capability" DEFAULT 'UNKNOWN' NOT NULL,
	"status" "calendar_connection_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_error_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_events" (
	"id" text PRIMARY KEY NOT NULL,
	"calendar_sync_id" text NOT NULL,
	"vacation_id" text,
	"provider_event_id" text,
	"kind" "calendar_sync_event_kind" NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "sync_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "calendar_connection" ADD CONSTRAINT "calendar_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD CONSTRAINT "calendar_sync_events_calendar_sync_id_calendar_sync_id_fk" FOREIGN KEY ("calendar_sync_id") REFERENCES "public"."calendar_sync"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD CONSTRAINT "calendar_sync_events_vacation_id_vacation_id_fk" FOREIGN KEY ("vacation_id") REFERENCES "public"."vacation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connection_user_provider_uniq" ON "calendar_connection" USING btree ("user_id","provider") WHERE "calendar_connection"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_events_config_vacation_uniq" ON "calendar_sync_events" USING btree ("calendar_sync_id","vacation_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_events_config" ON "calendar_sync_events" USING btree ("calendar_sync_id");--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD CONSTRAINT "calendar_sync_connection_id_calendar_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_connection" ON "calendar_sync" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_sync_due_at" ON "calendar_sync" USING btree ("sync_due_at") WHERE "calendar_sync"."sync_due_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD CONSTRAINT "calendar_sync_target_me_scope_chk" CHECK ("calendar_sync"."connection_id" IS NULL OR "calendar_sync"."scope" = 'ME');