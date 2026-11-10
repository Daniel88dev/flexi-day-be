CREATE TYPE "public"."assistant_pending_action_status" AS ENUM('open', 'confirmed', 'declined', 'not_taken');--> statement-breakpoint
CREATE TABLE "assistant_held_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"round_event_id" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"text" text NOT NULL,
	"is_error" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_pending_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"round_event_id" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"author_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "assistant_pending_action_status" DEFAULT 'open' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD COLUMN "text_authors" jsonb;--> statement-breakpoint
ALTER TABLE "assistant_held_answers" ADD CONSTRAINT "assistant_held_answers_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD CONSTRAINT "assistant_pending_actions_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD CONSTRAINT "assistant_pending_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD CONSTRAINT "assistant_pending_actions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_held_answers_tool_use" ON "assistant_held_answers" USING btree ("chat_id","tool_use_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_pending_actions_tool_use" ON "assistant_pending_actions" USING btree ("chat_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "idx_assistant_pending_actions_chat_status" ON "assistant_pending_actions" USING btree ("chat_id","status");