CREATE TYPE "public"."billing_cycle" AS ENUM('MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."manual_plan_override" AS ENUM('FREE', 'PRO', 'ENTERPRISE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."subscription_plan" AS ENUM('PRO', 'ENTERPRISE');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trialing', 'past_due', 'paused', 'canceled');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"billing_email" text NOT NULL,
	"paddle_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paddle_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"paddle_subscription_id" text,
	"paddle_customer_id" text,
	"plan" "subscription_plan",
	"status" "subscription_status",
	"billing_cycle" "billing_cycle",
	"extra_group_slots" integer DEFAULT 0 NOT NULL,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"manual_plan_override" "manual_plan_override",
	"manual_max_groups" integer,
	"manual_max_members_per_group" integer,
	"manual_plan_until" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organizations_owner_user_id" ON "organizations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscriptions_organization_id" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_paddle_subscription_id" ON "subscriptions" USING btree ("paddle_subscription_id");--> statement-breakpoint
-- Backfill: one organization per distinct group manager (soft-deleted groups
-- included — every row must satisfy the NOT NULL below), then attach each
-- group to its manager's org. `groups.manager_user_id` is NOT NULL with an FK
-- to `user`, so this join cannot drop a row.
INSERT INTO "organizations" ("id", "name", "owner_user_id", "billing_email")
SELECT gen_random_uuid()::text, u."name", u."id", u."email"
FROM (SELECT DISTINCT "manager_user_id" FROM "groups") AS m
JOIN "user" AS u ON u."id" = m."manager_user_id";--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "groups" AS g
SET "organization_id" = o."id"
FROM "organizations" AS o
WHERE o."owner_user_id" = g."manager_user_id";--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_groups_organization_id" ON "groups" USING btree ("organization_id");
