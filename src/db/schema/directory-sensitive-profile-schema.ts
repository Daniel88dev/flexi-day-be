import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { employments } from "./employment-schema.js";
import { organizations } from "./organization-schema.js";

/**
 * The Sensitive sections of one Employment's Profile, Contact and Personal.
 * Each column holds its whole Section as JSON sealed under the organization's
 * data key with `fieldContext("directory_sensitive_profiles", <column>,
 * employment_id)`, and is null while the Section is empty. Registered in
 * `ENCRYPTED_TABLES`, so a re-key walks it. Goes with its Employment, so
 * Erase removes it.
 */
export const directorySensitiveProfiles = pgTable(
  "directory_sensitive_profiles",
  {
    employmentId: text("employment_id")
      .primaryKey()
      .references(() => employments.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contact: text("contact"),
    personal: text("personal"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("idx_directory_sensitive_profiles_organization_id").on(table.organizationId)]
);
