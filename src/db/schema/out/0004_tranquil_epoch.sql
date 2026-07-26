CREATE TABLE "report_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"related_year" varchar(4) NOT NULL,
	"filters" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_year_quotas" ADD COLUMN "carried_over_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vacation" ADD COLUMN "half_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_exports_user_id_idx" ON "report_exports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "report_exports_created_at_idx" ON "report_exports" USING btree ("created_at");