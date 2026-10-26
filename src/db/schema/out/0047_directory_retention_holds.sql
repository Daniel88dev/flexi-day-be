CREATE TABLE "directory_retention_holds" (
	"employment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"set_by_user_id" text,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_retention_holds" ADD CONSTRAINT "directory_retention_holds_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_retention_holds" ADD CONSTRAINT "directory_retention_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_retention_holds" ADD CONSTRAINT "directory_retention_holds_set_by_user_id_user_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;