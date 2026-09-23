import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { organizations } from "./organization-schema.js";

/**
 * Audit trail of attendance settings writes, one row per save, written in the
 * same transaction as the save. Write-only by design — nothing in the product
 * reads it back; it answers "when was the self-service window open, and who
 * opened it".
 */
export const attendanceSettingsChanges = pgTable(
  "attendance_settings_changes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Nulled rather than cascaded, so deleting an admin's account keeps the trail.
    changedByUserId: text("changed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Null when the organization had never saved its settings before. */
    before: jsonb("before"),
    after: jsonb("after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("attendance_settings_changes_organization_id_idx").on(table.organizationId),
    index("attendance_settings_changes_created_at_idx").on(table.createdAt),
  ]
);
