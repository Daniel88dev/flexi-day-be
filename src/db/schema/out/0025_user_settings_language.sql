CREATE TYPE "public"."app_language" AS ENUM('en', 'cs');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "language" "app_language";