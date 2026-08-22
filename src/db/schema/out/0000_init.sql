CREATE TYPE "public"."calendar_sync_scope" AS ENUM('ME', 'TEAM');--> statement-breakpoint
CREATE TYPE "public"."changes_type" AS ENUM('GROUP', 'GROUP_USER', 'VACATION', 'USER_YEAR_QUOTAS');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('approval_requested', 'approval_decided', 'calendar_conflict', 'balance_low', 'comment');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('ADMIN');--> statement-breakpoint
CREATE TYPE "public"."billing_cycle" AS ENUM('MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."manual_plan_override" AS ENUM('FREE', 'PRO', 'ENTERPRISE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."subscription_plan" AS ENUM('PRO', 'ENTERPRISE');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trialing', 'past_due', 'paused', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."dashboard_scope" AS ENUM('MINE', 'GROUP');--> statement-breakpoint
CREATE TYPE "public"."vacation_event_type" AS ENUM('CREATED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMMENT', 'UPDATED');--> statement-breakpoint
CREATE TYPE "public"."vacation_type" AS ENUM('VACATION', 'HOME_OFFICE', 'SICK', 'BANK_HOLIDAY', 'NON_PAID_LEAVE', 'PAID_TIME_OFF', 'SICK_LEAVE', 'STUDY_LEAVE', 'OTHER');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"scope" "calendar_sync_scope" DEFAULT 'ME' NOT NULL,
	"distinguish_mine" boolean DEFAULT false NOT NULL,
	"token" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"calendar_sync_id" text NOT NULL,
	"group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_types" (
	"id" text PRIMARY KEY NOT NULL,
	"calendar_sync_id" text NOT NULL,
	"vacation_type" "vacation_type" NOT NULL,
	"color" text NOT NULL,
	"mine_color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"change_type" "changes_type" NOT NULL,
	"change_detail" text NOT NULL,
	"changing_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_group_id" text NOT NULL,
	"target_group_id" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"group_name" text NOT NULL,
	"default_vacation_days" integer DEFAULT 20 NOT NULL,
	"default_home_office_days" integer DEFAULT 0 NOT NULL,
	"working_days" integer[] DEFAULT '{1,2,3,4,5}' NOT NULL,
	"holiday_country" text,
	"manager_user_id" text NOT NULL,
	"main_approval_user" text,
	"temp_approval_user" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_users" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"view_access" boolean DEFAULT false NOT NULL,
	"admin_access" boolean DEFAULT false NOT NULL,
	"approver_access" boolean DEFAULT false NOT NULL,
	"controlled_user" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_link" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"code" text NOT NULL,
	"email" text,
	"invited_by_user_id" text,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_link_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "organization_users" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "organization_role" DEFAULT 'ADMIN' NOT NULL,
	"granted_by_user_id" text,
	"deleted_at" timestamp with time zone,
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
CREATE TABLE "report_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"related_year" varchar(4) NOT NULL,
	"filters" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "support_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method" varchar(8) NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email_notifications" boolean DEFAULT true NOT NULL,
	"dashboard_scope" "dashboard_scope" DEFAULT 'MINE' NOT NULL,
	"dashboard_group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_year_quotas" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"related_year" varchar(4) NOT NULL,
	"vacation_days" integer DEFAULT 20 NOT NULL,
	"home_office_days" integer DEFAULT 0 NOT NULL,
	"carried_over_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_year_quotas_related_year_chk" CHECK ("user_year_quotas"."related_year" ~ '^[0-9]{4}$'),
	CONSTRAINT "user_year_quotas_related_year_range_chk" CHECK ("user_year_quotas"."related_year"::int BETWEEN 2025 AND 2100)
);
--> statement-breakpoint
CREATE TABLE "vacation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"vacation_id" text NOT NULL,
	"event_type" "vacation_event_type" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vacation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"requested_day" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"vacation_type" "vacation_type" DEFAULT 'VACATION' NOT NULL,
	"half_day" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"rejected_at" timestamp with time zone,
	"rejected_by" text,
	"rejection_reason" text,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync" ADD CONSTRAINT "calendar_sync_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_teams" ADD CONSTRAINT "calendar_sync_teams_calendar_sync_id_calendar_sync_id_fk" FOREIGN KEY ("calendar_sync_id") REFERENCES "public"."calendar_sync"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_teams" ADD CONSTRAINT "calendar_sync_teams_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_types" ADD CONSTRAINT "calendar_sync_types_calendar_sync_id_calendar_sync_id_fk" FOREIGN KEY ("calendar_sync_id") REFERENCES "public"."calendar_sync"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_changing_user_id_user_id_fk" FOREIGN KEY ("changing_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_mirrors" ADD CONSTRAINT "group_mirrors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_mirrors" ADD CONSTRAINT "group_mirrors_source_group_id_groups_id_fk" FOREIGN KEY ("source_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_mirrors" ADD CONSTRAINT "group_mirrors_target_group_id_groups_id_fk" FOREIGN KEY ("target_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_manager_user_id_user_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_main_approval_user_user_id_fk" FOREIGN KEY ("main_approval_user") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_temp_approval_user_user_id_fk" FOREIGN KEY ("temp_approval_user") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_users" ADD CONSTRAINT "group_users_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_users" ADD CONSTRAINT "group_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access" ADD CONSTRAINT "support_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_dashboard_group_id_groups_id_fk" FOREIGN KEY ("dashboard_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_year_quotas" ADD CONSTRAINT "user_year_quotas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_year_quotas" ADD CONSTRAINT "user_year_quotas_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_events" ADD CONSTRAINT "vacation_events_vacation_id_vacation_id_fk" FOREIGN KEY ("vacation_id") REFERENCES "public"."vacation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_events" ADD CONSTRAINT "vacation_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_deleted_by_user_id_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_rejected_by_user_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation" ADD CONSTRAINT "vacation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_two_factor_user_id" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_two_factor_secret" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "bank_holidays_country_idx" ON "bank_holidays" USING btree ("country");--> statement-breakpoint
CREATE INDEX "bank_holidays_date_idx" ON "bank_holidays" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_holidays_country_region_date_uidx" ON "bank_holidays" USING btree ("country","region","date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_holidays_country_date_no_region_uidx" ON "bank_holidays" USING btree ("country","date") WHERE "bank_holidays"."region" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_token_uniq" ON "calendar_sync" USING btree ("token") WHERE "calendar_sync"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_user_id" ON "calendar_sync" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_teams_config_group_uniq" ON "calendar_sync_teams" USING btree ("calendar_sync_id","group_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_teams_config" ON "calendar_sync_teams" USING btree ("calendar_sync_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_types_config_type_uniq" ON "calendar_sync_types" USING btree ("calendar_sync_id","vacation_type");--> statement-breakpoint
CREATE INDEX "idx_calendar_sync_types_config" ON "calendar_sync_types" USING btree ("calendar_sync_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_mirrors_user_source_target_uniq" ON "group_mirrors" USING btree ("user_id","source_group_id","target_group_id") WHERE "group_mirrors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_group_mirrors_target_group_id" ON "group_mirrors" USING btree ("target_group_id");--> statement-breakpoint
CREATE INDEX "idx_group_mirrors_user_id" ON "group_mirrors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_groups_deleted_at_active" ON "groups" USING btree ("deleted_at") WHERE "groups"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_groups_organization_id" ON "groups" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_users_group_id_user_id_uniq" ON "group_users" USING btree ("group_id","user_id") WHERE "group_users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_group_users_group_id" ON "group_users" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_group_users_user_id" ON "group_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_invite_link_code" ON "invite_link" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_invite_link_group_id" ON "invite_link" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_link_group_email_open_uniq" ON "invite_link" USING btree ("group_id","email") WHERE "invite_link"."used_at" IS NULL AND "invite_link"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organizations_owner_user_id" ON "organizations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_users_org_id_user_id_uniq" ON "organization_users" USING btree ("organization_id","user_id") WHERE "organization_users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_organization_users_user_id" ON "organization_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_organization_users_organization_id" ON "organization_users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "report_exports_user_id_idx" ON "report_exports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "report_exports_created_at_idx" ON "report_exports" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscriptions_organization_id" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_paddle_subscription_id" ON "subscriptions" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE INDEX "support_access_user_id_idx" ON "support_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_access_created_at_idx" ON "support_access" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_group_year_quotas_user_year_uidx" ON "user_year_quotas" USING btree ("user_id","group_id","related_year");--> statement-breakpoint
CREATE INDEX "vacation_events_vacation_id_idx" ON "vacation_events" USING btree ("vacation_id","created_at");--> statement-breakpoint
CREATE INDEX "requested_day_idx" ON "vacation" USING btree ("requested_day");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vacation_user_day" ON "vacation" USING btree ("user_id","requested_day") WHERE "vacation"."deleted_at" IS NULL AND "vacation"."rejected_at" IS NULL;