CREATE TYPE "public"."push_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TABLE "auth_secret_fingerprint" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_registrations" (
	"session_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"environment" "push_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_registrations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "push_registrations" ADD CONSTRAINT "push_registrations_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;