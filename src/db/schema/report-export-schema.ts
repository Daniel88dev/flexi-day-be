import { index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

/**
 * Audit trail of report exports. Write-only by design — nothing in the product
 * reads it back; it exists so "who pulled this data, when, and for which
 * scope" can be answered after the fact.
 */
export const reportExports = pgTable(
  "report_exports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    relatedYear: varchar("related_year", { length: 4 }).notNull(),
    filters: jsonb("filters").notNull(),
    rowCount: integer("row_count").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("report_exports_user_id_idx").on(table.userId),
    index("report_exports_created_at_idx").on(table.createdAt),
  ]
);
