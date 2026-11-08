CREATE TABLE "assistant_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_chats_session" ON "assistant_chats" USING btree ("session_id") WHERE "assistant_chats"."session_id" IS NOT NULL;