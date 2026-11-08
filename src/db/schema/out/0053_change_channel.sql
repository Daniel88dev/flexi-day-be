CREATE TYPE "public"."change_channel" AS ENUM('app', 'assistant', 'mcp');--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "channel" "change_channel" DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "read_log" ADD COLUMN "channel" "change_channel" DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "vacation_events" ADD COLUMN "channel" "change_channel" DEFAULT 'app' NOT NULL;