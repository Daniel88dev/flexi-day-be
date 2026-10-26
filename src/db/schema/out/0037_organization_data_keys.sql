CREATE TYPE "public"."data_key_wrapping" AS ENUM('kms', 'local');--> statement-breakpoint
CREATE TABLE "organization_data_keys" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"wrapping" "data_key_wrapping" NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_data_keys" ADD CONSTRAINT "organization_data_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;