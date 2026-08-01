CREATE TYPE "public"."dashboard_scope" AS ENUM('MINE', 'GROUP');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "dashboard_scope" "dashboard_scope" DEFAULT 'MINE' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "dashboard_group_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_dashboard_group_id_groups_id_fk" FOREIGN KEY ("dashboard_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;