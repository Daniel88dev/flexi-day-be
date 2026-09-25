ALTER TABLE "invite_link" ADD COLUMN "link_secret_hash" text;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_link_secret_hash_unique" UNIQUE("link_secret_hash");