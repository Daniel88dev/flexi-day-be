import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { user } from "./auth-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/** An External worker is an Employment of type `external`; everyone else is an `employee`. */
export enum workerType {
  Employee = "employee",
  External = "external",
}

export const workerTypeEnum = pgEnum("employment_type", enumToPgEnum(workerType));

/**
 * One person's spell in one organization, the subject of attendance and of the
 * directory. Everything else derives who an organization's people are from the
 * union of the owner, the delegated admins, every group's manager and every
 * group's members
 * ([`docs/adr/0004`](../../../docs/adr/0004-attendance-is-org-scoped-via-employment.md)).
 *
 * One row per spell: someone who leaves and comes back gets a new row, and the
 * attendance sessions of the earlier spell stay on the earlier row. A partial
 * unique index keeps at most one open row per person and organization.
 *
 * `userId` is null for a person without an account. Such a row holds the
 * person's name and email itself, and its email is unique among the
 * organization's open Employments: a partial unique index covers two
 * account-less rows, and `assertNoAccountlessClash` refuses a join path that
 * would open a bound row beside one.
 *
 * `requiredMinutesPerDay` overrides the organization's rule for this one
 * person.
 *
 * `name` and `email` are the organization's own copy of who the person is.
 * While the row is open and bound the account wins: `syncEmployment` writes the
 * copy on open, and the `employments_follow_user` trigger (migration 0032)
 * rewrites it on every open row whenever `user.name` or `user.email` changes,
 * inside that UPDATE's transaction. An ended row keeps the copy it had when it
 * ended. `name` is nullable only so a deploy's old code could still insert
 * while 0032 ran; every write since sets it.
 *
 * `accountDeletedAt` is when the person deleted their account. The row stays
 * open and its copy stays frozen: the trigger skips it (migration 0033).
 */
export const employments = pgTable(
  "employments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    type: workerTypeEnum("type").notNull().default(workerType.Employee),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    email: text("email"),
    requiredMinutesPerDay: integer("required_minutes_per_day"),
    accountDeletedAt: timestamp("account_deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_employments_open_organization_id_user_id")
      .on(table.organizationId, table.userId)
      .where(sql`${table.endedAt} is null and ${table.userId} is not null`),
    uniqueIndex("uq_employments_open_accountless_email")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(
        sql`${table.endedAt} is null and ${table.userId} is null and ${table.email} is not null`
      ),
    // "Which organizations is this person employed by" has no other index.
    index("idx_employments_user_id").on(table.userId),
    index("idx_employments_organization_id").on(table.organizationId),
  ]
);
