ALTER TYPE "public"."notification_type" ADD VALUE 'directory_enabled';--> statement-breakpoint
ALTER TABLE "organization_directory_settings" ADD COLUMN "checklist_hidden_at" timestamp with time zone;