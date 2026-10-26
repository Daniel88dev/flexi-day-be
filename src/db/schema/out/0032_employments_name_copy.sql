ALTER TABLE "employments" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "employments" ADD COLUMN "email" text;--> statement-breakpoint
UPDATE "employments" SET "name" = "user"."name", "email" = "user"."email" FROM "user" WHERE "user"."id" = "employments"."user_id";--> statement-breakpoint
CREATE FUNCTION "employments_follow_user"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "employments"
  SET "name" = NEW."name", "email" = NEW."email", "updated_at" = now()
  WHERE "user_id" = NEW."id" AND "ended_at" IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "employments_follow_user"
AFTER UPDATE OF "name", "email" ON "user"
FOR EACH ROW
WHEN (OLD."name" IS DISTINCT FROM NEW."name" OR OLD."email" IS DISTINCT FROM NEW."email")
EXECUTE FUNCTION "employments_follow_user"();
