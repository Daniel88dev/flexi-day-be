import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth-schema.js";
import { groups } from "./group-schema.js";
import { vacationEnum } from "./vacation-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/**
 * Whose records a calendar feed exposes.
 * - `ME`: only the owner's own records.
 * - `TEAM`: records of the included teams (see {@link calendarSyncTeams}).
 */
export enum calendarSyncScope {
  Me = "ME",
  Team = "TEAM",
}

export const calendarSyncScopeEnum = pgEnum(
  "calendar_sync_scope",
  enumToPgEnum(calendarSyncScope)
);

/**
 * A calendar-sync feed configuration owned by a user. Each row corresponds to
 * one read-only iCalendar subscription link. The `token` is the secret that
 * authenticates the public feed endpoint; regenerating it revokes the old link.
 */
export const calendarSync = pgTable(
  "calendar_sync",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scope: calendarSyncScopeEnum("scope")
      .notNull()
      .default(calendarSyncScope.Me),
    // When true and scope is TEAM, the owner's own records use the per-type
    // `mineColor` so they stand out from the rest of the team's.
    distinguishMine: boolean("distinguish_mine").notNull().default(false),
    token: text("token").notNull(),
    lastFetchedAt: timestamp("last_fetched_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The token is looked up on every feed fetch and must resolve to a single
    // live config. Unique among non-deleted rows so a regenerated/deleted
    // token can never collide with an active one.
    uniqueIndex("calendar_sync_token_uniq")
      .on(table.token)
      .where(sql`${table.deletedAt} IS NULL`),
    index("idx_calendar_sync_user_id").on(table.userId),
  ]
);

/**
 * Teams (groups) included in a `TEAM`-scoped feed. Ignored for `ME` scope but
 * still persisted so the builder can restore the user's selection on edit.
 */
export const calendarSyncTeams = pgTable(
  "calendar_sync_teams",
  {
    id: text("id").primaryKey(),
    calendarSyncId: text("calendar_sync_id")
      .notNull()
      .references(() => calendarSync.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_sync_teams_config_group_uniq").on(
      table.calendarSyncId,
      table.groupId
    ),
    index("idx_calendar_sync_teams_config").on(table.calendarSyncId),
  ]
);

/**
 * Leave/record types included in a feed, each with its display color. When the
 * feed distinguishes the owner's own records, `mineColor` is used for those.
 * Presence of a row means the type is included in the feed.
 */
export const calendarSyncTypes = pgTable(
  "calendar_sync_types",
  {
    id: text("id").primaryKey(),
    calendarSyncId: text("calendar_sync_id")
      .notNull()
      .references(() => calendarSync.id, { onDelete: "cascade" }),
    vacationType: vacationEnum("vacation_type").notNull(),
    // Swatch key from the shared palette (e.g. "violet"), not a raw color.
    color: text("color").notNull(),
    mineColor: text("mine_color"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_sync_types_config_type_uniq").on(
      table.calendarSyncId,
      table.vacationType
    ),
    index("idx_calendar_sync_types_config").on(table.calendarSyncId),
  ]
);
