CREATE TABLE "support_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method" varchar(8) NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_access" ADD CONSTRAINT "support_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_access_user_id_idx" ON "support_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_access_created_at_idx" ON "support_access" USING btree ("created_at");