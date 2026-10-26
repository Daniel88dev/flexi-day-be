import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { user } from "./auth-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/** The rows of the Permission table: six Sections, then the directory acts. */
export enum directoryPermissionRow {
  Card = "CARD",
  Photo = "PHOTO",
  WorkContact = "WORK_CONTACT",
  Job = "JOB",
  Contact = "CONTACT",
  Personal = "PERSONAL",
  CreateAccountlessPerson = "CREATE_ACCOUNTLESS_PERSON",
  SendDirectoryInvite = "SEND_DIRECTORY_INVITE",
  ChangeWorkerType = "CHANGE_WORKER_TYPE",
  EndEmployment = "END_EMPLOYMENT",
  ManageDepartmentsAndLocations = "MANAGE_DEPARTMENTS_AND_LOCATIONS",
}

/** The columns of the Permission table. */
export enum directoryAudience {
  Owner = "OWNER",
  Self = "SELF",
  Colleague = "COLLEAGUE",
  ExternalWorker = "EXTERNAL_WORKER",
  GroupAdmin = "GROUP_ADMIN",
  Hr = "HR",
  Leadership = "LEADERSHIP",
  OrganizationAdmin = "ORGANIZATION_ADMIN",
}

/** A Section cell holds none, read or write; an act cell holds allowed or no. */
export enum directoryPermissionValue {
  None = "NONE",
  Read = "READ",
  Write = "WRITE",
  Allowed = "ALLOWED",
  No = "NO",
}

export const directoryPermissionRowEnum = pgEnum(
  "directory_permission_row",
  enumToPgEnum(directoryPermissionRow)
);
export const directoryAudienceEnum = pgEnum("directory_audience", enumToPgEnum(directoryAudience));
export const directoryPermissionValueEnum = pgEnum(
  "directory_permission_value",
  enumToPgEnum(directoryPermissionValue)
);

/**
 * One row per organization, written the first time its owner turns the
 * directory on. Turning it off flips `enabled` and keeps every other directory
 * row. A lapse writes nothing: whether writes are open is derived from the plan
 * at read time (`isDirectoryWritable`).
 */
export const organizationDirectorySettings = pgTable("organization_directory_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  enabledByUserId: text("enabled_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledByUserId: text("disabled_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  /** The organization's own Art. 14 emergency-contact notice; null reads as the product default. */
  emergencyContactNoticeEn: text("emergency_contact_notice_en"),
  emergencyContactNoticeCs: text("emergency_contact_notice_cs"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

/** Every acceptance of the directory agreement, one row per enable or re-acceptance. */
export const directoryAgreementAcceptances = pgTable(
  "directory_agreement_acceptances",
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
    index("idx_directory_agreement_acceptances_organization_id").on(
      table.organizationId,
      table.acceptedAt
    ),
  ]
);

/**
 * The organization's own copy of the Permission table, one row per cell. A cell
 * the product default has no entry for (Self on an act row, Group admin on End)
 * has no row. Fixed cells are stored like the rest; which cells are fixed is a
 * product rule (`DIRECTORY_PERMISSION_DEFAULTS`).
 */
export const directoryPermissionCells = pgTable(
  "directory_permission_cells",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    row: directoryPermissionRowEnum("row").notNull(),
    audience: directoryAudienceEnum("audience").notNull(),
    value: directoryPermissionValueEnum("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.row, table.audience] })]
);
