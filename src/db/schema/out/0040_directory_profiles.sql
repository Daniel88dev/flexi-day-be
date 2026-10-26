CREATE TYPE "public"."directory_contract_type" AS ENUM('PERMANENT', 'FIXED_TERM', 'APPRENTICESHIP', 'INTERNSHIP', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."directory_working_time" AS ENUM('FULL_TIME', 'PART_TIME');--> statement-breakpoint
CREATE TABLE "directory_profile_history" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"employment_id" text NOT NULL,
	"actor_user_id" text,
	"section" "directory_permission_row" NOT NULL,
	"fields" text[] NOT NULL,
	"audience" "directory_audience" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_profiles" (
	"employment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"job_title" text,
	"reports_to_employment_id" text,
	"legal_name" text,
	"employee_number" text,
	"start_date" date,
	"leaving_date" date,
	"probation_end_date" date,
	"contract_type" "directory_contract_type",
	"working_time" "directory_working_time",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_profile_history" ADD CONSTRAINT "directory_profile_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profile_history" ADD CONSTRAINT "directory_profile_history_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profile_history" ADD CONSTRAINT "directory_profile_history_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_reports_to_employment_id_employments_id_fk" FOREIGN KEY ("reports_to_employment_id") REFERENCES "public"."employments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_directory_profile_history_employment" ON "directory_profile_history" USING btree ("employment_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_directory_profiles_organization_id" ON "directory_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_directory_profiles_reports_to" ON "directory_profiles" USING btree ("reports_to_employment_id");