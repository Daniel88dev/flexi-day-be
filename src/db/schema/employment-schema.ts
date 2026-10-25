import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { user } from "./auth-schema.js";

/**
 * One person's membership in one organization — the subject of attendance,
 * and the first thing in the product that says who an organization's people
 * are. Everything else derives that set from the union of the owner, the
 * delegated admins, every group's manager and every group's members
 * ([`docs/adr/0004`](../../../docs/adr/0004-attendance-is-org-scoped-via-employment.md)).
 *
 * Unique on the pair, so the row carries the **current spell** rather than a
 * history: someone who leaves and comes back reopens this row with a new
 * `startedAt`, and the spell they served before is gone. Attendance sessions
 * survive that — they hang off the employment id, not off the spell.
 *
 * `requiredMinutesPerDay` overrides the organization's rule for this one
 * person. Nothing reads it until the month view.
 *
 * `name` and `email` are the organization's own copy of who the person is.
 * While the row is open the account wins: `syncEmployment` writes the copy on
 * open, and the `employments_follow_user` trigger (migration 0032) rewrites it
 * on every open row whenever `user.name` or `user.email` changes, inside that
 * UPDATE's transaction. An ended row keeps the copy it had when it ended.
 * `name` is nullable only so a deploy's old code can still insert while 0032
 * runs; every write since sets it.
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
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
    // Covers live and ended rows alike — unlike `group_users`, where a repeated
    // join has to insert a second row, a reopen here updates this one.
    uniqueIndex("uq_employments_organization_id_user_id").on(table.organizationId, table.userId),
    // "Which organizations is this person employed by" has no other index.
    index("idx_employments_user_id").on(table.userId),
  ]
);
