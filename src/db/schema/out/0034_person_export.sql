CREATE TYPE "public"."person_export_status" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."read_log_audience" AS ENUM('OWNER', 'ORGANIZATION_ADMIN', 'SELF');--> statement-breakpoint
CREATE TYPE "public"."read_log_kind" AS ENUM('export');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'export_ready';--> statement-breakpoint
CREATE TABLE "person_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"status" "person_export_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"size_bytes" bigint,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "read_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" "read_log_kind" NOT NULL,
	"reader_user_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"employment_ids" text[] NOT NULL,
	"audience" "read_log_audience" NOT NULL,
	"person_export_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_exports" ADD CONSTRAINT "person_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_exports" ADD CONSTRAINT "person_exports_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_exports" ADD CONSTRAINT "person_exports_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_log" ADD CONSTRAINT "read_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_log" ADD CONSTRAINT "read_log_reader_user_id_user_id_fk" FOREIGN KEY ("reader_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_log" ADD CONSTRAINT "read_log_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_person_exports_requester" ON "person_exports" USING btree ("requested_by_user_id","organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_person_exports_pending" ON "person_exports" USING btree ("created_at") WHERE "person_exports"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "idx_read_log_subject" ON "read_log" USING btree ("organization_id","subject_user_id","created_at");--> statement-breakpoint
CREATE FUNCTION "read_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'read_log is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "read_log_append_only" BEFORE UPDATE ON "read_log" FOR EACH ROW EXECUTE FUNCTION "read_log_append_only"();
