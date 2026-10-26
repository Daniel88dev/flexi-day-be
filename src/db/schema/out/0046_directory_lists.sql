CREATE TABLE "directory_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"country" text
);
--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "directory_departments" ADD CONSTRAINT "directory_departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_locations" ADD CONSTRAINT "directory_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_directory_departments_organization_name" ON "directory_departments" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_directory_locations_organization_name" ON "directory_locations" USING btree ("organization_id",lower("name"));--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_department_id_directory_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."directory_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD CONSTRAINT "directory_profiles_location_id_directory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."directory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_directory_profiles_department" ON "directory_profiles" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "idx_directory_profiles_location" ON "directory_profiles" USING btree ("location_id");