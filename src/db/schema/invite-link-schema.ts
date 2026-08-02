import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { groups } from "./group-schema.js";
import { user } from "./auth-schema.js";

export const inviteLink = pgTable(
  "invite_link",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    code: text("code").unique().notNull(),
    // Lower-cased address the invite was issued to. Redeeming is restricted to
    // an account with this email, so a forwarded code is useless to a stranger.
    // Nullable only for rows predating email invites — those stay unrestricted.
    email: text("email"),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    idxInviteLinkCode: index("idx_invite_link_code").on(table.code),
    idxInviteLinkGroupId: index("idx_invite_link_group_id").on(table.groupId),
    // At most one live invite per (group, email); re-inviting the same address
    // reuses that row instead of leaving several codes that all still work.
    uniqOpenInvite: uniqueIndex("invite_link_group_email_open_uniq")
      .on(table.groupId, table.email)
      .where(sql`${table.usedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  })
);
