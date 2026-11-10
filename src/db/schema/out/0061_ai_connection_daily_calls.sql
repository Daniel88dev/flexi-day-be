CREATE TABLE "ai_connection_daily_calls" (
	"organization_id" text NOT NULL,
	"day" date DEFAULT (date_trunc('day', now() AT TIME ZONE 'UTC'))::date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"limit_reached_at" timestamp with time zone,
	CONSTRAINT "ai_connection_daily_calls_organization_id_day_pk" PRIMARY KEY("organization_id","day")
);
--> statement-breakpoint
CREATE TABLE "ai_connection_member_daily_calls" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" date DEFAULT (date_trunc('day', now() AT TIME ZONE 'UTC'))::date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_connection_member_daily_calls_organization_id_day_user_id_pk" PRIMARY KEY("organization_id","day","user_id")
);
--> statement-breakpoint
ALTER TABLE "ai_connection_daily_calls" ADD CONSTRAINT "ai_connection_daily_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_member_daily_calls" ADD CONSTRAINT "ai_connection_member_daily_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_member_daily_calls" ADD CONSTRAINT "ai_connection_member_daily_calls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;