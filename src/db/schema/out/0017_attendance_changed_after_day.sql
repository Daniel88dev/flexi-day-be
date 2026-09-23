ALTER TYPE "public"."attendance_event_type" ADD VALUE 'SESSION_CHECKED';--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "changed_after_day" boolean DEFAULT false NOT NULL;