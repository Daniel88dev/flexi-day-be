CREATE TYPE "public"."directory_role" AS ENUM('HR', 'LEADERSHIP');--> statement-breakpoint
CREATE TYPE "public"."directory_permission_history_kind" AS ENUM('CELL', 'ROLE');--> statement-breakpoint
CREATE TYPE "public"."directory_role_change_reason" AS ENUM('OWNER', 'EMPLOYMENT_ENDED', 'ACCOUNT_DELETED');--> statement-breakpoint
CREATE TABLE "directory_permission_history" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text,
	"kind" "directory_permission_history_kind" NOT NULL,
	"row" "directory_permission_row",
	"audience" "directory_audience",
	"value_before" "directory_permission_value",
	"value_after" "directory_permission_value",
	"role" "directory_role",
	"employment_id" text,
	"held_before" boolean,
	"held_after" boolean,
	"reason" "directory_role_change_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_role_assignments" (
	"employment_id" text NOT NULL,
	"role" "directory_role" NOT NULL,
	"organization_id" text NOT NULL,
	"assigned_by_user_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_role_assignments_employment_id_role_pk" PRIMARY KEY("employment_id","role")
);
--> statement-breakpoint
ALTER TABLE "directory_permission_history" ADD CONSTRAINT "directory_permission_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_permission_history" ADD CONSTRAINT "directory_permission_history_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_permission_history" ADD CONSTRAINT "directory_permission_history_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_role_assignments" ADD CONSTRAINT "directory_role_assignments_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_role_assignments" ADD CONSTRAINT "directory_role_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_role_assignments" ADD CONSTRAINT "directory_role_assignments_assigned_by_user_id_user_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_directory_permission_history_organization" ON "directory_permission_history" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_directory_role_assignments_organization_id" ON "directory_role_assignments" USING btree ("organization_id");