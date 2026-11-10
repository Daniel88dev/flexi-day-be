ALTER TYPE "public"."notification_type" ADD VALUE 'assistant_enabled';--> statement-breakpoint
CREATE TABLE "ai_agreement_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"accepted_by_user_id" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "assistant_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "assistant_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_agreement_acceptances" ADD CONSTRAINT "ai_agreement_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agreement_acceptances" ADD CONSTRAINT "ai_agreement_acceptances_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_agreement_acceptances_organization_version" ON "ai_agreement_acceptances" USING btree ("organization_id","version");--> statement-breakpoint
CREATE INDEX "idx_ai_agreement_acceptances_organization_id" ON "ai_agreement_acceptances" USING btree ("organization_id","accepted_at");