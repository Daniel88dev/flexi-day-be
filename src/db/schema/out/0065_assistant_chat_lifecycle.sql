CREATE TABLE "assistant_session_deletions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD COLUMN "context_tokens" integer DEFAULT 0 NOT NULL;