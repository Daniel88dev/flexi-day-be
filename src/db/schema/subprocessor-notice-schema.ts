import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { organizations } from "./organization-schema.js";

/**
 * The notice our DPA promises before a new sub-processor starts: one row per organization and
 * sub-processor, written by `pnpm run subprocessor-notice` in the same transaction as the send.
 * The first `sent_at` for `anthropic` starts the Assistant's 30 days.
 */
export const subprocessorNotices = pgTable(
  "subprocessor_notices",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subprocessor: text("subprocessor").notNull(),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.subprocessor] })]
);
