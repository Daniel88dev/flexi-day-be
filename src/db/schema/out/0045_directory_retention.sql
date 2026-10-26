CREATE TYPE "public"."directory_history_actor" AS ENUM('PERSON', 'RETENTION');--> statement-breakpoint
CREATE TYPE "public"."directory_retention_period" AS ENUM('AT_END', 'DAYS_30', 'MONTHS_6', 'YEAR_1', 'YEARS_3', 'YEARS_5', 'YEARS_10', 'UNTIL_ERASED');--> statement-breakpoint
CREATE TABLE "directory_retention_periods" (
	"organization_id" text NOT NULL,
	"section" "directory_permission_row" NOT NULL,
	"period" "directory_retention_period" NOT NULL,
	"changed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_retention_periods_organization_id_section_pk" PRIMARY KEY("organization_id","section")
);
--> statement-breakpoint
ALTER TABLE "directory_profile_history" ALTER COLUMN "audience" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_profile_history" ADD COLUMN "actor" "directory_history_actor" DEFAULT 'PERSON' NOT NULL;--> statement-breakpoint
ALTER TABLE "employments" ADD COLUMN "end_recorded_at" timestamp with time zone;--> statement-breakpoint
-- The moment an existing ending was written is unknown; updated_at is never earlier than it, so no clock starts early.
UPDATE "employments" SET "end_recorded_at" = greatest("ended_at", "updated_at") WHERE "ended_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_retention_periods" ADD CONSTRAINT "directory_retention_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_retention_periods" ADD CONSTRAINT "directory_retention_periods_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profile_history" ADD CONSTRAINT "directory_profile_history_actor_chk" CHECK (("directory_profile_history"."actor" = 'PERSON' and "directory_profile_history"."audience" is not null) or ("directory_profile_history"."actor" = 'RETENTION' and "directory_profile_history"."audience" is null and "directory_profile_history"."actor_user_id" is null));