CREATE TYPE "public"."balance_mode" AS ENUM('DAILY', 'MONTHLY');--> statement-breakpoint
CREATE TABLE "organization_attendance_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"attendance_enabled" boolean DEFAULT false NOT NULL,
	"location_enabled" boolean DEFAULT false NOT NULL,
	"timezone" text,
	"holiday_country" text,
	"working_days" integer[] DEFAULT '{1,2,3,4,5}' NOT NULL,
	"break_minutes" integer DEFAULT 30 NOT NULL,
	"break_threshold_minutes" integer DEFAULT 360 NOT NULL,
	"required_minutes_per_day" integer DEFAULT 480 NOT NULL,
	"balance_mode" "balance_mode" DEFAULT 'DAILY' NOT NULL,
	"session_ceiling_minutes" integer DEFAULT 960 NOT NULL,
	"break_ceiling_minutes" integer DEFAULT 120 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_attendance_settings" ADD CONSTRAINT "organization_attendance_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;