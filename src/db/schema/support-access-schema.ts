import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

/**
 * Audit trail of the platform-support read surface (`/api/support/*`). One row
 * per request, written by `requireSupportAdmin` before the handler runs.
 * Write-only by design — nothing in the product reads it back; it exists so
 * "who looked at whose data, when" can be answered after the fact.
 */
export const supportAccess = pgTable(
  "support_access",
  {
    id: text("id").primaryKey(),
    // No ON DELETE cascade, unlike `report_exports`: that table audits tenant
    // users reading their own groups, this one audits platform staff reading
    // anyone's data — deleting the staff account must not erase the trail.
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    method: varchar("method", { length: 8 }).notNull(),
    /** Path plus query string, so the audited row names the exact target. */
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("support_access_user_id_idx").on(table.userId),
    index("support_access_created_at_idx").on(table.createdAt),
  ]
);
