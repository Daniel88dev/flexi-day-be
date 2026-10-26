import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";

const entryColumns = () => ({
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Archived entries leave the pickers but stay on the records that hold them. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

/**
 * An organization's own list of Departments. Not tied to groups. An entry is
 * deleted only while no Profile, open or former, points at it.
 */
export const directoryDepartments = pgTable("directory_departments", entryColumns(), (table) => [
  uniqueIndex("uq_directory_departments_organization_name").on(
    table.organizationId,
    sql`lower(${table.name})`
  ),
]);

/**
 * An organization's own list of work Locations. The country never drives
 * holidays, working days or attendance; it only starts the phone picker.
 */
export const directoryLocations = pgTable(
  "directory_locations",
  {
    ...entryColumns(),
    /** ISO 3166-1 alpha-2, upper case. */
    country: text("country"),
  },
  (table) => [
    uniqueIndex("uq_directory_locations_organization_name").on(
      table.organizationId,
      sql`lower(${table.name})`
    ),
  ]
);
