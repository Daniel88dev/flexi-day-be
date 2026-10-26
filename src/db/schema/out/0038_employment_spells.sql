CREATE TYPE "public"."employment_type" AS ENUM('employee', 'external');--> statement-breakpoint
DROP INDEX "uq_employments_organization_id_user_id";--> statement-breakpoint
ALTER TABLE "employments" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "employments" ADD COLUMN "type" "employment_type" DEFAULT 'employee' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_employments_open_organization_id_user_id" ON "employments" USING btree ("organization_id","user_id") WHERE "employments"."ended_at" is null and "employments"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_employments_open_accountless_email" ON "employments" USING btree ("organization_id",lower("email")) WHERE "employments"."ended_at" is null and "employments"."user_id" is null and "employments"."email" is not null;--> statement-breakpoint
CREATE INDEX "idx_employments_organization_id" ON "employments" USING btree ("organization_id");