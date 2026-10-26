ALTER TABLE "invite_link" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_link" ADD COLUMN "employment_id" text;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invite_link_employment_open_uniq" ON "invite_link" USING btree ("employment_id") WHERE "invite_link"."used_at" IS NULL AND "invite_link"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_target_chk" CHECK ("invite_link"."group_id" IS NOT NULL OR "invite_link"."employment_id" IS NOT NULL);