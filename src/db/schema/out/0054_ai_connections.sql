CREATE TYPE "public"."ai_connections_level" AS ENUM('off', 'read', 'write');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'ai_connections_enabled';--> statement-breakpoint
CREATE TABLE "ai_connections_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"changed_by_user_id" text,
	"before" "ai_connections_level" NOT NULL,
	"after" "ai_connections_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "ai_connections" "ai_connections_level" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "ai_connections_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_connections_changes" ADD CONSTRAINT "ai_connections_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connections_changes" ADD CONSTRAINT "ai_connections_changes_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_connections_changes_organization_id" ON "ai_connections_changes" USING btree ("organization_id","created_at");