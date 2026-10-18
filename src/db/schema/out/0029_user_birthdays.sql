CREATE TABLE "user_birthdays" (
	"user_id" text PRIMARY KEY NOT NULL,
	"month" smallint,
	"day" smallint,
	"year" smallint,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_birthdays_tombstone_chk" CHECK (("user_birthdays"."deleted_at" IS NULL AND "user_birthdays"."month" IS NOT NULL AND "user_birthdays"."day" IS NOT NULL)
        OR ("user_birthdays"."deleted_at" IS NOT NULL AND "user_birthdays"."month" IS NULL AND "user_birthdays"."day" IS NULL AND "user_birthdays"."year" IS NULL)),
	CONSTRAINT "user_birthdays_month_chk" CHECK ("user_birthdays"."month" BETWEEN 1 AND 12),
	CONSTRAINT "user_birthdays_day_chk" CHECK ("user_birthdays"."day" BETWEEN 1 AND 31),
	CONSTRAINT "user_birthdays_year_chk" CHECK ("user_birthdays"."year" >= 1900)
);
--> statement-breakpoint
ALTER TABLE "user_birthdays" ADD CONSTRAINT "user_birthdays_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_events" ADD CONSTRAINT "calendar_sync_events_birthday_user_id_user_birthdays_user_id_fk" FOREIGN KEY ("birthday_user_id") REFERENCES "public"."user_birthdays"("user_id") ON DELETE set null ON UPDATE no action;