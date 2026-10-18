ALTER TABLE "group_events" DROP CONSTRAINT "group_events_title_chk";--> statement-breakpoint
ALTER TABLE "group_events" DROP CONSTRAINT "group_events_repeat_chk";--> statement-breakpoint
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_title_chk" CHECK ("group_events"."deleted_at" IS NOT NULL
        OR ("group_events"."title" IS NOT NULL AND char_length("group_events"."title") BETWEEN 1 AND 100));--> statement-breakpoint
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_repeat_chk" CHECK (("group_events"."repeat_freq" IS NULL AND "group_events"."repeat_interval" IS NULL AND "group_events"."repeat_weekdays" IS NULL
          AND "group_events"."repeat_monthly_mode" IS NULL AND "group_events"."repeat_until" IS NULL)
        OR ("group_events"."repeat_freq" IS NOT NULL AND "group_events"."repeat_interval" IS NOT NULL
          AND "group_events"."repeat_interval" BETWEEN 1 AND 99 AND "group_events"."end_date" = "group_events"."start_date"));