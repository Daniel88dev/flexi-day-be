CREATE TABLE "subprocessor_notices" (
	"organization_id" text NOT NULL,
	"subprocessor" text NOT NULL,
	"owner_user_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subprocessor_notices_organization_id_subprocessor_pk" PRIMARY KEY("organization_id","subprocessor")
);
--> statement-breakpoint
ALTER TABLE "subprocessor_notices" ADD CONSTRAINT "subprocessor_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subprocessor_notices" ADD CONSTRAINT "subprocessor_notices_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;