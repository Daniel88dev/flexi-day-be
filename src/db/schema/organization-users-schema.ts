import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organization-schema.js";
import { user } from "./auth-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum organizationRole {
  Admin = "ADMIN",
}

export const organizationRoleEnum = pgEnum("organization_role", enumToPgEnum(organizationRole));

/**
 * Delegated administrators of an organization. The **owner is not stored
 * here** — it is `organizations.ownerUserId`, the same way a group's manager
 * sits on `groups.managerUserId` rather than carrying a `group_users` row.
 * Readers must therefore treat owner-or-row as "org admin"; a bare lookup in
 * this table answers only half the question.
 *
 * An org admin is an administrator *over* the org's groups, not a member of
 * them: no quota row, no place in a group's member list, no ability to book
 * leave there.
 */
export const organizationUsers = pgTable(
  "organization_users",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: organizationRoleEnum("role").notNull().default(organizationRole.Admin),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("organization_users_org_id_user_id_uniq")
      .on(table.organizationId, table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
    // Every group-scoped authorization check falls back to "is the caller an
    // admin of this group's org", keyed by user.
    index("idx_organization_users_user_id").on(table.userId),
    index("idx_organization_users_organization_id").on(table.organizationId),
  ]
);
