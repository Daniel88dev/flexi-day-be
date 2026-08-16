CREATE TYPE "public"."organization_role" AS ENUM('ADMIN');--> statement-breakpoint
CREATE TABLE "organization_users" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "organization_role" DEFAULT 'ADMIN' NOT NULL,
	"granted_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_users_org_id_user_id_uniq" ON "organization_users" USING btree ("organization_id","user_id") WHERE "organization_users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_organization_users_user_id" ON "organization_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_organization_users_organization_id" ON "organization_users" USING btree ("organization_id");