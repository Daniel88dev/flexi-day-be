ALTER TABLE "groups" ADD COLUMN "default_sick_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sick_day_benefit_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_year_quotas" ADD COLUMN "sick_days" integer DEFAULT 0 NOT NULL;