import { boolean, index, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import {
  directoryAudienceEnum,
  directoryPermissionRowEnum,
  directoryPermissionValueEnum,
} from "./directory-schema.js";
import { employments } from "./employment-schema.js";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum directoryRole {
  Hr = "HR",
  Leadership = "LEADERSHIP",
}

export const directoryRoleEnum = pgEnum("directory_role", enumToPgEnum(directoryRole));

/**
 * A Directory role held on one open, bound Employment. Only the owner assigns
 * one. The rows go when the Employment ends or its account is deleted, and a
 * rejoin is a new Employment, so it starts without them.
 */
export const directoryRoleAssignments = pgTable(
  "directory_role_assignments",
  {
    employmentId: text("employment_id")
      .notNull()
      .references(() => employments.id, { onDelete: "cascade" }),
    role: directoryRoleEnum("role").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.employmentId, table.role] }),
    index("idx_directory_role_assignments_organization_id").on(table.organizationId),
  ]
);

export enum permissionHistoryKind {
  Cell = "CELL",
  Role = "ROLE",
}

export enum roleChangeReason {
  /** The owner assigned or removed it. */
  Owner = "OWNER",
  EmploymentEnded = "EMPLOYMENT_ENDED",
  AccountDeleted = "ACCOUNT_DELETED",
}

export const permissionHistoryKindEnum = pgEnum(
  "directory_permission_history_kind",
  enumToPgEnum(permissionHistoryKind)
);
export const roleChangeReasonEnum = pgEnum(
  "directory_role_change_reason",
  enumToPgEnum(roleChangeReason)
);

/**
 * Permission history: every change to an organization's Permission table and
 * its Directory role assignments. A cell entry keeps the row, audience and the
 * value before and after; a role entry keeps the role, the Employment and
 * whether it was held before and after. Kept for the organization's life;
 * erasing the person only drops the Employment reference.
 */
export const directoryPermissionHistory = pgTable(
  "directory_permission_history",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    kind: permissionHistoryKindEnum("kind").notNull(),
    row: directoryPermissionRowEnum("row"),
    audience: directoryAudienceEnum("audience"),
    valueBefore: directoryPermissionValueEnum("value_before"),
    valueAfter: directoryPermissionValueEnum("value_after"),
    role: directoryRoleEnum("role"),
    employmentId: text("employment_id").references(() => employments.id, {
      onDelete: "set null",
    }),
    heldBefore: boolean("held_before"),
    heldAfter: boolean("held_after"),
    reason: roleChangeReasonEnum("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_directory_permission_history_organization").on(
      table.organizationId,
      table.createdAt
    ),
  ]
);
