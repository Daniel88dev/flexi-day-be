CREATE TYPE "public"."person_export_scope" AS ENUM('PERSON', 'ORGANIZATION');--> statement-breakpoint
ALTER TABLE "person_exports" ALTER COLUMN "subject_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "person_exports" ADD COLUMN "scope" "person_export_scope" DEFAULT 'PERSON' NOT NULL;--> statement-breakpoint
ALTER TABLE "person_exports" ADD CONSTRAINT "person_exports_subject_chk" CHECK (("person_exports"."scope" = 'PERSON') = ("person_exports"."subject_user_id" IS NOT NULL));