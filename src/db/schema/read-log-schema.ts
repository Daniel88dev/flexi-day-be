import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { directoryPermissionRowEnum } from "./directory-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum readLogKind {
  Export = "export",
  /** A Show of a Sensitive section of someone else's Profile. */
  Read = "read",
}

export const readLogKindEnum = pgEnum("read_log_kind", enumToPgEnum(readLogKind));

/** The standing the reader read with; the person export shows it as the purpose. */
export enum readLogAudience {
  Owner = "OWNER",
  OrganizationAdmin = "ORGANIZATION_ADMIN",
  Self = "SELF",
  Hr = "HR",
  Leadership = "LEADERSHIP",
  GroupAdmin = "GROUP_ADMIN",
  Colleague = "COLLEAGUE",
  ExternalWorker = "EXTERNAL_WORKER",
}

export const readLogAudienceEnum = pgEnum("read_log_audience", enumToPgEnum(readLogAudience));

/**
 * The Read log: who read what about a person, and when. Append-only: no route
 * updates or deletes a row, and a trigger (migration 0034) refuses every
 * UPDATE. Rows go only with their organization, or with the nightly purge of
 * rows older than 12 months.
 *
 * `employmentIds` carries no foreign key on purpose: erasing a person deletes
 * their Employments, and the rows about them outlive that. A read of a record
 * without an account has no `subjectUserId`; its Employment id names it.
 */
export const readLog = pgTable(
  "read_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: readLogKindEnum("kind").notNull(),
    readerUserId: text("reader_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "cascade" }),
    employmentIds: text("employment_ids").array().notNull(),
    /** The Sections a `read` row opened; null on `export` rows. */
    sections: directoryPermissionRowEnum("sections").array(),
    audience: readLogAudienceEnum("audience").notNull(),
    personExportId: text("person_export_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_read_log_subject").on(table.organizationId, table.subjectUserId, table.createdAt),
    index("idx_read_log_reader").on(table.organizationId, table.readerUserId, table.createdAt),
    index("idx_read_log_created_at").on(table.createdAt),
    check(
      "read_log_subject_chk",
      sql`${table.subjectUserId} is not null or cardinality(${table.employmentIds}) > 0`
    ),
  ]
);
