CREATE TABLE "attendance_settings_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"changed_by_user_id" text,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_attendance_settings" ADD COLUMN "self_service_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_attendance_settings" ADD COLUMN "self_service_days" integer DEFAULT 0;--> statement-breakpoint
-- Organizations that already use attendance keep today-only, the rule they had. New rows start off.
UPDATE "organization_attendance_settings" SET "self_service_enabled" = true, "self_service_days" = 0;--> statement-breakpoint
ALTER TABLE "attendance_settings_changes" ADD CONSTRAINT "attendance_settings_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings_changes" ADD CONSTRAINT "attendance_settings_changes_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_settings_changes_organization_id_idx" ON "attendance_settings_changes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "attendance_settings_changes_created_at_idx" ON "attendance_settings_changes" USING btree ("created_at");