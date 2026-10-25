ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employments" ADD COLUMN "account_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "employments_follow_user"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "employments"
  SET "name" = NEW."name", "email" = NEW."email", "updated_at" = now()
  WHERE "user_id" = NEW."id" AND "ended_at" IS NULL AND "account_deleted_at" IS NULL;
  RETURN NULL;
END;
$$;
