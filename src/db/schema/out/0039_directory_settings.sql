CREATE TYPE "public"."directory_audience" AS ENUM('OWNER', 'SELF', 'COLLEAGUE', 'EXTERNAL_WORKER', 'GROUP_ADMIN', 'HR', 'LEADERSHIP', 'ORGANIZATION_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."directory_permission_row" AS ENUM('CARD', 'PHOTO', 'WORK_CONTACT', 'JOB', 'CONTACT', 'PERSONAL', 'CREATE_ACCOUNTLESS_PERSON', 'SEND_DIRECTORY_INVITE', 'CHANGE_WORKER_TYPE', 'END_EMPLOYMENT', 'MANAGE_DEPARTMENTS_AND_LOCATIONS');--> statement-breakpoint
CREATE TYPE "public"."directory_permission_value" AS ENUM('NONE', 'READ', 'WRITE', 'ALLOWED', 'NO');--> statement-breakpoint
CREATE TABLE "directory_agreement_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"accepted_by_user_id" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_permission_cells" (
	"organization_id" text NOT NULL,
	"row" "directory_permission_row" NOT NULL,
	"audience" "directory_audience" NOT NULL,
	"value" "directory_permission_value" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_permission_cells_organization_id_row_audience_pk" PRIMARY KEY("organization_id","row","audience")
);
--> statement-breakpoint
CREATE TABLE "organization_directory_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by_user_id" text,
	"disabled_at" timestamp with time zone,
	"disabled_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_agreement_acceptances" ADD CONSTRAINT "directory_agreement_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_agreement_acceptances" ADD CONSTRAINT "directory_agreement_acceptances_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_permission_cells" ADD CONSTRAINT "directory_permission_cells_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_directory_settings" ADD CONSTRAINT "organization_directory_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_directory_settings" ADD CONSTRAINT "organization_directory_settings_enabled_by_user_id_user_id_fk" FOREIGN KEY ("enabled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_directory_settings" ADD CONSTRAINT "organization_directory_settings_disabled_by_user_id_user_id_fk" FOREIGN KEY ("disabled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_directory_agreement_acceptances_organization_id" ON "directory_agreement_acceptances" USING btree ("organization_id","accepted_at");