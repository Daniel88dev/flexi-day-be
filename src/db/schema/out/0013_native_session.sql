ALTER TABLE "session" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "app_version" text;--> statement-breakpoint
CREATE INDEX "idx_session_device_id" ON "session" USING btree ("device_id");