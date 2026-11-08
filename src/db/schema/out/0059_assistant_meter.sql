CREATE TYPE "public"."assistant_call_purpose" AS ENUM('main', 'screen');--> statement-breakpoint
CREATE TYPE "public"."assistant_call_status" AS ENUM('reserved', 'settled');--> statement-breakpoint
CREATE TABLE "assistant_model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"chat_id" text,
	"session_id" text,
	"event_id" text,
	"trigger_event_id" text,
	"week_start" date DEFAULT (date_trunc('week', now() AT TIME ZONE 'UTC'))::date NOT NULL,
	"purpose" "assistant_call_purpose" NOT NULL,
	"model_id" text NOT NULL,
	"price_version" text NOT NULL,
	"status" "assistant_call_status" DEFAULT 'reserved' NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"settled_micro_usd" bigint,
	"input_tokens" integer,
	"cache_write_5m_tokens" integer,
	"cache_write_1h_tokens" integer,
	"cache_read_tokens" integer,
	"output_tokens" integer,
	"thinking_tokens" integer,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assistant_model_calls" ADD CONSTRAINT "assistant_model_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_model_calls" ADD CONSTRAINT "assistant_model_calls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_model_calls" ADD CONSTRAINT "assistant_model_calls_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_model_calls_org_week" ON "assistant_model_calls" USING btree ("organization_id","week_start");--> statement-breakpoint
CREATE INDEX "idx_assistant_model_calls_session" ON "assistant_model_calls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_assistant_model_calls_open" ON "assistant_model_calls" USING btree ("created_at") WHERE "assistant_model_calls"."status" = 'reserved';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assistant_model_calls_trigger" ON "assistant_model_calls" USING btree ("session_id","trigger_event_id") WHERE "assistant_model_calls"."trigger_event_id" IS NOT NULL;