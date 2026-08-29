-- Rename the stored enum value in place; every existing row follows automatically.
-- The enum itself keeps its historical name (docs/adr/0002-calendar-record-type-rename.md).
ALTER TYPE "public"."vacation_type" RENAME VALUE 'SICK_LEAVE' TO 'SICK_DAY';
