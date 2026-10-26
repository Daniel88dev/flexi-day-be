import { date, index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { directoryAudienceEnum, directoryPermissionRowEnum } from "./directory-schema.js";
import { employments } from "./employment-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum contractType {
  Permanent = "PERMANENT",
  FixedTerm = "FIXED_TERM",
  Apprenticeship = "APPRENTICESHIP",
  Internship = "INTERNSHIP",
  Other = "OTHER",
}

export enum workingTime {
  FullTime = "FULL_TIME",
  PartTime = "PART_TIME",
}

export const contractTypeEnum = pgEnum("directory_contract_type", enumToPgEnum(contractType));
export const workingTimeEnum = pgEnum("directory_working_time", enumToPgEnum(workingTime));

/**
 * The Card, Work contact and Job fields of one Employment's Profile. The row appears the
 * first time someone saves a field; a missing row reads as an empty profile.
 * It goes with its Employment, so Erase removes it. Ending or erasing the
 * Employment named in `reportsToEmploymentId` never deletes this row: erasing
 * clears the reference.
 */
export const directoryProfiles = pgTable(
  "directory_profiles",
  {
    employmentId: text("employment_id")
      .primaryKey()
      .references(() => employments.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobTitle: text("job_title"),
    reportsToEmploymentId: text("reports_to_employment_id").references(() => employments.id, {
      onDelete: "set null",
    }),
    legalName: text("legal_name"),
    employeeNumber: text("employee_number"),
    startDate: date("start_date", { mode: "string" }),
    leavingDate: date("leaving_date", { mode: "string" }),
    probationEndDate: date("probation_end_date", { mode: "string" }),
    contractType: contractTypeEnum("contract_type"),
    workingTime: workingTimeEnum("working_time"),
    /** Lowercase, never synced with the sign-in email. */
    workEmail: text("work_email"),
    /** E.164. */
    workPhone: text("work_phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("idx_directory_profiles_organization_id").on(table.organizationId),
    index("idx_directory_profiles_reports_to").on(table.reportsToEmploymentId),
  ]
);

/**
 * Profile history: one row per Section a write changed, naming the fields and
 * the Audience that granted the write. It never holds a value, so it can't
 * copy data out of reach of retention or encryption. Kept as long as the
 * Employment.
 */
export const directoryProfileHistory = pgTable(
  "directory_profile_history",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    employmentId: text("employment_id")
      .notNull()
      .references(() => employments.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    section: directoryPermissionRowEnum("section").notNull(),
    fields: text("fields").array().notNull(),
    audience: directoryAudienceEnum("audience").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_directory_profile_history_employment").on(table.employmentId, table.createdAt),
  ]
);
