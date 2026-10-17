CREATE TYPE "public"."group_event_monthly_mode" AS ENUM('DAY', 'NTH_WEEKDAY', 'LAST_WEEKDAY');--> statement-breakpoint
CREATE TYPE "public"."group_event_repeat_freq" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TABLE "group_events" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"created_by_user_id" text,
	"title" text,
	"note" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"repeat_freq" "group_event_repeat_freq",
	"repeat_interval" smallint,
	"repeat_weekdays" smallint[],
	"repeat_monthly_mode" "group_event_monthly_mode",
	"repeat_until" date,
	"skipped_dates" date[] DEFAULT '{}'::date[] NOT NULL,
	"recurring_event_id" text,
	"original_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "group_events_dates_chk" CHECK ("group_events"."end_date" >= "group_events"."start_date"),
	CONSTRAINT "group_events_title_chk" CHECK ("group_events"."deleted_at" IS NOT NULL OR char_length("group_events"."title") BETWEEN 1 AND 100),
	CONSTRAINT "group_events_note_chk" CHECK ("group_events"."note" IS NULL OR char_length("group_events"."note") <= 1000),
	CONSTRAINT "group_events_times_chk" CHECK (("group_events"."start_time" IS NULL) = ("group_events"."end_time" IS NULL)
        AND ("group_events"."start_date" <> "group_events"."end_date" OR "group_events"."start_time" IS NULL OR "group_events"."end_time" > "group_events"."start_time")),
	CONSTRAINT "group_events_repeat_chk" CHECK (("group_events"."repeat_freq" IS NULL AND "group_events"."repeat_interval" IS NULL AND "group_events"."repeat_weekdays" IS NULL
          AND "group_events"."repeat_monthly_mode" IS NULL AND "group_events"."repeat_until" IS NULL)
        OR ("group_events"."repeat_freq" IS NOT NULL AND "group_events"."repeat_interval" BETWEEN 1 AND 99
          AND "group_events"."end_date" = "group_events"."start_date")),
	CONSTRAINT "group_events_repeat_until_chk" CHECK ("group_events"."repeat_until" IS NULL OR "group_events"."repeat_until" >= "group_events"."start_date")
);
--> statement-breakpoint
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_recurring_event_id_group_events_id_fk" FOREIGN KEY ("recurring_event_id") REFERENCES "public"."group_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_group_events_group_id" ON "group_events" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_group_events_recurring_event_id" ON "group_events" USING btree ("recurring_event_id");--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD CONSTRAINT "calendar_sync_events_group_event_id_group_events_id_fk" FOREIGN KEY ("group_event_id") REFERENCES "public"."group_events"("id") ON DELETE set null ON UPDATE no action;