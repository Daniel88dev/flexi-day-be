CREATE TYPE "public"."assistant_message_kind" AS ENUM('user', 'assistant', 'tool', 'notice');--> statement-breakpoint
CREATE TYPE "public"."assistant_turn_status" AS ENUM('idle', 'running');--> statement-breakpoint
CREATE TABLE "assistant_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"chat_id" text NOT NULL,
	"kind" "assistant_message_kind" NOT NULL,
	"text" text,
	"tool_name" text,
	"tool_outcome" text,
	"code" text,
	"event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"session_id" text,
	"agent_version" integer,
	"turn_status" "assistant_turn_status" DEFAULT 'idle' NOT NULL,
	"turn_started_at" timestamp with time zone,
	"turn_start_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD CONSTRAINT "assistant_chats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD CONSTRAINT "assistant_chats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_chat_messages_chat" ON "assistant_chat_messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_chat_messages_event" ON "assistant_chat_messages" USING btree ("chat_id","event_id") WHERE "assistant_chat_messages"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_assistant_chats_user_last_message" ON "assistant_chats" USING btree ("user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_chats_organization" ON "assistant_chats" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_chats_running_turn_per_user" ON "assistant_chats" USING btree ("user_id") WHERE "assistant_chats"."turn_status" = 'running';