import { pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { directoryPermissionRowEnum } from "./directory-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/** How long a Section is kept after an Employment ends, shortest first. */
export enum retentionPeriod {
  AtEnd = "AT_END",
  Days30 = "DAYS_30",
  Months6 = "MONTHS_6",
  Year1 = "YEAR_1",
  Years3 = "YEARS_3",
  Years5 = "YEARS_5",
  Years10 = "YEARS_10",
  UntilErased = "UNTIL_ERASED",
}

export const retentionPeriodEnum = pgEnum(
  "directory_retention_period",
  enumToPgEnum(retentionPeriod)
);

/**
 * An organization's Retention period per Section. A Section without a row
 * reads as the product default (`RETENTION_DEFAULTS`). No due date is stored
 * anywhere: the nightly purge works it out from the clock start and the
 * current row, so a change here applies to Employments that already ended.
 */
export const directoryRetentionPeriods = pgTable(
  "directory_retention_periods",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    section: directoryPermissionRowEnum("section").notNull(),
    period: retentionPeriodEnum("period").notNull(),
    changedByUserId: text("changed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.section] })]
);
