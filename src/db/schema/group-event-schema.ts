import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { groups } from "./group-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum groupEventRepeatFreq {
  Daily = "DAILY",
  Weekly = "WEEKLY",
  Monthly = "MONTHLY",
  Yearly = "YEARLY",
}

export const groupEventRepeatFreqEnum = pgEnum(
  "group_event_repeat_freq",
  enumToPgEnum(groupEventRepeatFreq)
);

export enum groupEventMonthlyMode {
  Day = "DAY",
  NthWeekday = "NTH_WEEKDAY",
  LastWeekday = "LAST_WEEKDAY",
}

export const groupEventMonthlyModeEnum = pgEnum(
  "group_event_monthly_mode",
  enumToPgEnum(groupEventMonthlyMode)
);

/**
 * An informational entry on one group's calendar. A row with `repeat_freq` set
 * is a recurring group event and lasts one day. Delete leaves a tombstone: the
 * content and rule wiped, `id`, `group_id` and the dates kept, `deleted_at` set.
 */
export const groupEvents = pgTable(
  "group_events",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    note: text("note"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    repeatFreq: groupEventRepeatFreqEnum("repeat_freq"),
    repeatInterval: smallint("repeat_interval"),
    // 0 = Monday … 6 = Sunday, unlike `groups.working_days`.
    repeatWeekdays: smallint("repeat_weekdays").array(),
    repeatMonthlyMode: groupEventMonthlyModeEnum("repeat_monthly_mode"),
    repeatUntil: date("repeat_until"),
    skippedDates: date("skipped_dates")
      .array()
      .notNull()
      .default(sql`'{}'::date[]`),
    // A one-off made by a "this event" edit points at the recurring group event it replaced a day of.
    recurringEventId: text("recurring_event_id").references((): AnyPgColumn => groupEvents.id, {
      onDelete: "set null",
    }),
    originalDate: date("original_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_group_events_group_id").on(table.groupId),
    index("idx_group_events_recurring_event_id").on(table.recurringEventId),
    check("group_events_dates_chk", sql`${table.endDate} >= ${table.startDate}`),
    check(
      "group_events_title_chk",
      sql`${table.deletedAt} IS NOT NULL
        OR (${table.title} IS NOT NULL AND char_length(${table.title}) BETWEEN 1 AND 100)`
    ),
    check(
      "group_events_note_chk",
      sql`${table.note} IS NULL OR char_length(${table.note}) <= 1000`
    ),
    check(
      "group_events_times_chk",
      sql`(${table.startTime} IS NULL) = (${table.endTime} IS NULL)
        AND (${table.startDate} <> ${table.endDate} OR ${table.startTime} IS NULL OR ${table.endTime} > ${table.startTime})`
    ),
    check(
      "group_events_repeat_chk",
      sql`(${table.repeatFreq} IS NULL AND ${table.repeatInterval} IS NULL AND ${table.repeatWeekdays} IS NULL
          AND ${table.repeatMonthlyMode} IS NULL AND ${table.repeatUntil} IS NULL)
        OR (${table.repeatFreq} IS NOT NULL AND ${table.repeatInterval} IS NOT NULL
          AND ${table.repeatInterval} BETWEEN 1 AND 99 AND ${table.endDate} = ${table.startDate})`
    ),
    check(
      "group_events_repeat_until_chk",
      sql`${table.repeatUntil} IS NULL OR ${table.repeatUntil} >= ${table.startDate}`
    ),
  ]
);
