import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth-schema.js";
import { calendarSync } from "./calendar-sync-schema.js";
import { vacation } from "./vacation-schema.js";
import { userBirthdays } from "./user-birthday-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum calendarProvider {
  Google = "GOOGLE",
  Microsoft = "MICROSOFT",
}

export const calendarProviderEnum = pgEnum("calendar_provider", enumToPgEnum(calendarProvider));

/**
 * Whether the account accepts Google's status event types (working location,
 * out of office). `UNKNOWN` until the first status write answers.
 */
export enum calendarCapability {
  Unknown = "UNKNOWN",
  Status = "STATUS",
  Plain = "PLAIN",
}

export const calendarCapabilityEnum = pgEnum(
  "calendar_capability",
  enumToPgEnum(calendarCapability)
);

export enum calendarConnectionStatus {
  Active = "ACTIVE",
  NeedsReconnect = "NEEDS_RECONNECT",
}

export const calendarConnectionStatusEnum = pgEnum(
  "calendar_connection_status",
  enumToPgEnum(calendarConnectionStatus)
);

export enum calendarSyncEventKind {
  Absence = "ABSENCE",
  HomeOffice = "HOME_OFFICE",
  GroupEvent = "GROUP_EVENT",
  Birthday = "BIRTHDAY",
}

export const calendarSyncEventKindEnum = pgEnum(
  "calendar_sync_event_kind",
  enumToPgEnum(calendarSyncEventKind)
);

/**
 * A user's write access to their own Google or Microsoft calendar. Its own
 * consent and refresh token, never the sign-in `account` row.
 */
export const calendarConnection = pgTable(
  "calendar_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: calendarProviderEnum("provider").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    grantedScopes: text("granted_scopes").notNull(),
    capability: calendarCapabilityEnum("capability").notNull().default(calendarCapability.Unknown),
    status: calendarConnectionStatusEnum("status")
      .notNull()
      .default(calendarConnectionStatus.Active),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    // Held by the instance syncing or purging this connection; any instance may take it once past.
    syncLeaseUntil: timestamp("sync_lease_until", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("calendar_connection_user_provider_uniq")
      .on(table.userId, table.provider)
      .where(sql`${table.revokedAt} IS NULL`),
  ]
);

/** The sync ledger: what the app wrote at the provider for each target and source record. */
export const calendarSyncEvents = pgTable(
  "calendar_sync_events",
  {
    id: text("id").primaryKey(),
    calendarSyncId: text("calendar_sync_id")
      .notNull()
      .references(() => calendarSync.id, { onDelete: "cascade" }),
    // `v:<vacationId>`, `ge:<groupEventId>` or `bd:<userId>`, plus `:<n>` when one source writes
    // several events. It outlives the source's FK column, so a hard delete still leaves the set.
    sourceKey: text("source_key").notNull(),
    // Null once the vacation row is hard-deleted: the provider event still has to go.
    vacationId: text("vacation_id").references(() => vacation.id, { onDelete: "set null" }),
    // No FK until `group_events` exists; that ticket adds it, `on delete set null`.
    groupEventId: text("group_event_id"),
    birthdayUserId: text("birthday_user_id").references(() => userBirthdays.userId, {
      onDelete: "set null",
    }),
    providerEventId: text("provider_event_id"),
    kind: calendarSyncEventKindEnum("kind").notNull(),
    // Google's `eventType`, which Google never lets an existing event change.
    eventType: text("event_type"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("calendar_sync_events_config_source_uniq").on(
      table.calendarSyncId,
      table.sourceKey
    ),
    index("idx_calendar_sync_events_config").on(table.calendarSyncId),
  ]
);

/**
 * Dev only: every call `CALENDAR_SYNC_DRIVER=fake` received, in place of a
 * provider. Production never writes it; boot refuses the fake driver there.
 */
export const calendarSyncFakeEvents = pgTable(
  "calendar_sync_fake_events",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => calendarConnection.id, { onDelete: "cascade" }),
    provider: calendarProviderEnum("provider").notNull(),
    operation: text("operation").$type<"INSERT" | "PATCH" | "DELETE">().notNull(),
    providerEventId: text("provider_event_id"),
    payload: jsonb("payload"),
    // "ok", or the failure the driver returned.
    result: text("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_calendar_sync_fake_events_connection").on(table.connectionId)]
);
