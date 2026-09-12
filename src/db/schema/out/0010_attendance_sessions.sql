CREATE TYPE "public"."attendance_closed_by" AS ENUM('USER', 'ADMIN', 'SWEEP');--> statement-breakpoint
CREATE TYPE "public"."attendance_event_type" AS ENUM('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END');--> statement-breakpoint
CREATE TABLE "attendance_breaks" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"auto_closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"event_type" "attendance_event_type" NOT NULL,
	"changed_by_user_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"employment_id" text NOT NULL,
	"business_date" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"timezone" text NOT NULL,
	"closed_by" "attendance_closed_by",
	"start_latitude" double precision,
	"start_longitude" double precision,
	"start_accuracy" double precision,
	"end_latitude" double precision,
	"end_longitude" double precision,
	"end_accuracy" double precision,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_breaks" ADD CONSTRAINT "attendance_breaks_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_deleted_by_user_id_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attendance_breaks_open_per_session" ON "attendance_breaks" USING btree ("session_id") WHERE "attendance_breaks"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "idx_attendance_breaks_session_id" ON "attendance_breaks" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_attendance_events_session_id" ON "attendance_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attendance_sessions_open_per_employment" ON "attendance_sessions" USING btree ("employment_id") WHERE "attendance_sessions"."ended_at" is null and "attendance_sessions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_attendance_sessions_employment_business_date" ON "attendance_sessions" USING btree ("employment_id","business_date");