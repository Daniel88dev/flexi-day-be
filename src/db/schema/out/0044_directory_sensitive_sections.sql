ALTER TYPE "public"."read_log_audience" ADD VALUE 'HR';--> statement-breakpoint
ALTER TYPE "public"."read_log_audience" ADD VALUE 'LEADERSHIP';--> statement-breakpoint
ALTER TYPE "public"."read_log_audience" ADD VALUE 'GROUP_ADMIN';--> statement-breakpoint
ALTER TYPE "public"."read_log_audience" ADD VALUE 'COLLEAGUE';--> statement-breakpoint
ALTER TYPE "public"."read_log_audience" ADD VALUE 'EXTERNAL_WORKER';--> statement-breakpoint
ALTER TYPE "public"."read_log_kind" ADD VALUE 'read';--> statement-breakpoint
CREATE TABLE "directory_sensitive_profiles" (
	"employment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact" text,
	"personal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "read_log" ALTER COLUMN "subject_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_directory_settings" ADD COLUMN "emergency_contact_notice_en" text;--> statement-breakpoint
ALTER TABLE "organization_directory_settings" ADD COLUMN "emergency_contact_notice_cs" text;--> statement-breakpoint
ALTER TABLE "read_log" ADD COLUMN "sections" "directory_permission_row"[];--> statement-breakpoint
ALTER TABLE "directory_sensitive_profiles" ADD CONSTRAINT "directory_sensitive_profiles_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_sensitive_profiles" ADD CONSTRAINT "directory_sensitive_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_directory_sensitive_profiles_organization_id" ON "directory_sensitive_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_read_log_reader" ON "read_log" USING btree ("organization_id","reader_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_read_log_created_at" ON "read_log" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "read_log" ADD CONSTRAINT "read_log_subject_chk" CHECK ("read_log"."subject_user_id" is not null or cardinality("read_log"."employment_ids") > 0);