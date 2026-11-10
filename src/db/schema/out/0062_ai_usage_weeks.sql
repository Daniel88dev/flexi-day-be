CREATE TABLE "ai_usage_organization_weeks" (
	"organization_id" text NOT NULL,
	"week_start" date NOT NULL,
	"used_micro_usd" bigint DEFAULT 0 NOT NULL,
	"limit_reached_at" timestamp with time zone,
	"ai_connection_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_organization_weeks_organization_id_week_start_pk" PRIMARY KEY("organization_id","week_start")
);
--> statement-breakpoint
CREATE TABLE "ai_usage_user_weeks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"week_start" date NOT NULL,
	"used_micro_usd" bigint DEFAULT 0 NOT NULL,
	"ai_connection_calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_organization_weeks" ADD CONSTRAINT "ai_usage_organization_weeks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_user_weeks" ADD CONSTRAINT "ai_usage_user_weeks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_user_weeks" ADD CONSTRAINT "ai_usage_user_weeks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_user_weeks_org_week" ON "ai_usage_user_weeks" USING btree ("organization_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_usage_user_weeks_person" ON "ai_usage_user_weeks" USING btree ("organization_id","week_start","user_id") WHERE "ai_usage_user_weeks"."user_id" IS NOT NULL;