CREATE TYPE "public"."assistant_rejection_reason" AS ENUM('off_topic', 'attack');--> statement-breakpoint
CREATE TABLE "assistant_rejected_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" text,
	"reason" "assistant_rejection_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_rejected_turns" ADD CONSTRAINT "assistant_rejected_turns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_rejected_turns" ADD CONSTRAINT "assistant_rejected_turns_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_rejected_turns" ADD CONSTRAINT "assistant_rejected_turns_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_rejected_turns_organization_created" ON "assistant_rejected_turns" USING btree ("organization_id","created_at");