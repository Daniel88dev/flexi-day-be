import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { user } from "./auth-schema.js";

/** Every acceptance of the AI features agreement: one row per organization and version. */
export const aiAgreementAcceptances = pgTable(
  "ai_agreement_acceptances",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_ai_agreement_acceptances_organization_version").on(
      table.organizationId,
      table.version
    ),
    index("idx_ai_agreement_acceptances_organization_id").on(
      table.organizationId,
      table.acceptedAt
    ),
  ]
);
