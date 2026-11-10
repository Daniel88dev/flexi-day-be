import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { aiConnectionsLevelEnum, organizations } from "./organization-schema.js";

/**
 * The setting change log for AI connections: one row per change of the
 * owner's setting, written in the same transaction. Write-only, like
 * `attendance_settings_changes`.
 */
export const aiConnectionsChanges = pgTable(
  "ai_connections_changes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    changedByUserId: text("changed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    before: aiConnectionsLevelEnum("before").notNull(),
    after: aiConnectionsLevelEnum("after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_connections_changes_organization_id").on(table.organizationId, table.createdAt),
  ]
);
