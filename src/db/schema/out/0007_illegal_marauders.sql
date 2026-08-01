CREATE TABLE "group_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_group_id" text NOT NULL,
	"target_group_id" text NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "invited_by_user_id" text;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "group_mirrors" ADD CONSTRAINT "group_mirrors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_mirrors" ADD CONSTRAINT "group_mirrors_source_group_id_groups_id_fk" FOREIGN KEY ("source_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_mirrors" ADD CONSTRAINT "group_mirrors_target_group_id_groups_id_fk" FOREIGN KEY ("target_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_mirrors_user_source_target_uniq" ON "group_mirrors" USING btree ("user_id","source_group_id","target_group_id") WHERE "group_mirrors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_group_mirrors_target_group_id" ON "group_mirrors" USING btree ("target_group_id");--> statement-breakpoint
CREATE INDEX "idx_group_mirrors_user_id" ON "group_mirrors" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invite_link_group_id" ON "invite_link" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_link_group_email_open_uniq" ON "invite_link" USING btree ("group_id","email") WHERE "invite_link"."used_at" IS NULL AND "invite_link"."revoked_at" IS NULL;