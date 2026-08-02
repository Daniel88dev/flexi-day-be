import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { groups } from "./group-schema.js";
import { user } from "./auth-schema.js";

/**
 * One user's opt-in to have their records from `sourceGroupId` shown inside
 * `targetGroupId`. Purely a read-side projection: no vacation row is ever
 * copied, so quota accounting, approvals and reports all continue to belong to
 * the source group alone. A mirrored record is therefore never approvable in
 * the target group — the approval queries key on `vacation.groupId`.
 */
export const groupMirrors = pgTable(
  "group_mirrors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceGroupId: text("source_group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    targetGroupId: text("target_group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    uniqActiveMirror: uniqueIndex("group_mirrors_user_source_target_uniq")
      .on(table.userId, table.sourceGroupId, table.targetGroupId)
      .where(sql`${table.deletedAt} IS NULL`),
    idxTargetGroup: index("idx_group_mirrors_target_group_id").on(table.targetGroupId),
    idxUser: index("idx_group_mirrors_user_id").on(table.userId),
  })
);
