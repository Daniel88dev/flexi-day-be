import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth-schema.js";
import { employments } from "./employment-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum personExportStatus {
  Pending = "PENDING",
  Ready = "READY",
  Failed = "FAILED",
}

export const personExportStatusEnum = pgEnum(
  "person_export_status",
  enumToPgEnum(personExportStatus)
);

/** A Person export covers one person; an Organization export covers everyone in it. */
export enum personExportScope {
  Person = "PERSON",
  Organization = "ORGANIZATION",
}

export const personExportScopeEnum = pgEnum("person_export_scope", enumToPgEnum(personExportScope));

/**
 * One request for a Person export or an Organization export (`docs/person-export.md`). The row is what
 * survives a restart: a `PENDING` row is built again by whichever instance
 * picks it up. A build in progress holds a session advisory lock on the id,
 * not a status, so a process that dies mid-build frees it. An Organization
 * export has no subject. A Person export names its subject by the user, or by
 * the Employment when the person has no account.
 */
export const personExports = pgTable(
  "person_exports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: personExportScopeEnum("scope").notNull().default(personExportScope.Person),
    subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "cascade" }),
    subjectEmploymentId: text("subject_employment_id").references(() => employments.id, {
      onDelete: "cascade",
    }),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: personExportStatusEnum("status").notNull().default(personExportStatus.Pending),
    attempts: integer("attempts").notNull().default(0),
    storageKey: text("storage_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("idx_person_exports_requester").on(
      table.requestedByUserId,
      table.organizationId,
      table.createdAt
    ),
    index("idx_person_exports_pending")
      .on(table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
    check(
      "person_exports_subject_chk",
      sql`(${table.scope} = 'PERSON') = (${table.subjectUserId} IS NOT NULL OR ${table.subjectEmploymentId} IS NOT NULL) AND NOT (${table.subjectUserId} IS NOT NULL AND ${table.subjectEmploymentId} IS NOT NULL)`
    ),
  ]
);
