import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { groups } from "./group-schema.js";

export const inviteLink = pgTable(
  "invite_link",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    code: text("code").unique().notNull(),
    usedAt: timestamp("used_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    idxInviteLinkCode: index("idx_invite_link_code").on(table.code),
  })
);
