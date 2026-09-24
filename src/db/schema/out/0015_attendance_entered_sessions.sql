CREATE TYPE "public"."attendance_session_origin" AS ENUM('CLOCKED', 'ENTERED');--> statement-breakpoint
ALTER TYPE "public"."attendance_event_type" ADD VALUE 'SESSION_CREATED';--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "origin" "attendance_session_origin" DEFAULT 'CLOCKED' NOT NULL;