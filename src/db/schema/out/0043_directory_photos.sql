CREATE TYPE "public"."directory_photo_status" AS ENUM('UPLOADING', 'READY', 'REJECTED');--> statement-breakpoint
CREATE TABLE "directory_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"employment_id" text NOT NULL,
	"status" "directory_photo_status" DEFAULT 'UPLOADING' NOT NULL,
	"rejection_reason" text,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by_user_id" text,
	"audience" "directory_audience" NOT NULL,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_photos" ADD CONSTRAINT "directory_photos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_photos" ADD CONSTRAINT "directory_photos_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_photos" ADD CONSTRAINT "directory_photos_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_directory_photos_ready_employment" ON "directory_photos" USING btree ("employment_id") WHERE "directory_photos"."status" = 'READY';--> statement-breakpoint
CREATE INDEX "idx_directory_photos_employment" ON "directory_photos" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "idx_directory_photos_organization" ON "directory_photos" USING btree ("organization_id");