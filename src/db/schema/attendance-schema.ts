import {
  boolean,
  date,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { employments } from "./employment-schema.js";
import { user } from "./auth-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

/** Who ended a session: the person themselves, an admin correcting it, or the sweep. */
export enum attendanceClosedBy {
  User = "USER",
  Admin = "ADMIN",
  Sweep = "SWEEP",
}

export const attendanceClosedByEnum = pgEnum(
  "attendance_closed_by",
  enumToPgEnum(attendanceClosedBy)
);

/**
 * One spell of presence, hanging off an Employment rather than a group — a
 * person clocks in once however many groups they belong to
 * ([`docs/attendance.md`](../../../docs/attendance.md)).
 *
 * `businessDate` is fixed at clock-in from `timezone`, the organization's zone
 * at that instant, and never moves: a session that crosses midnight belongs
 * wholly to the day it started. The zone is stored beside it because the
 * organization may change its own later, and a recomputed date would silently
 * move history.
 *
 * The six location columns arrive nullable and unused — the location ticket
 * fills them, and lands as a behaviour change rather than a migration. Nothing
 * in this ticket writes them.
 */
export const attendanceSessions = pgTable(
  "attendance_sessions",
  {
    id: text("id").primaryKey(),
    employmentId: text("employment_id")
      .notNull()
      .references(() => employments.id, { onDelete: "cascade" }),
    businessDate: date("business_date").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // IANA zone, as it stood at clock-in.
    timezone: text("timezone").notNull(),
    // Null while the session is open.
    closedBy: attendanceClosedByEnum("closed_by"),
    startLatitude: doublePrecision("start_latitude"),
    startLongitude: doublePrecision("start_longitude"),
    startAccuracy: doublePrecision("start_accuracy"),
    endLatitude: doublePrecision("end_latitude"),
    endLongitude: doublePrecision("end_longitude"),
    endAccuracy: doublePrecision("end_accuracy"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: text("deleted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The only thing that actually holds "one open session per Employment".
    // The read-then-insert in `clockIn` races under READ COMMITTED: two
    // parallel requests both see no open session, and this index is what makes
    // exactly one of them win.
    uniqueIndex("uq_attendance_sessions_open_per_employment")
      .on(table.employmentId)
      .where(sql`${table.endedAt} is null and ${table.deletedAt} is null`),
    // The day view and the month view both read by employment and date.
    index("idx_attendance_sessions_employment_business_date").on(
      table.employmentId,
      table.businessDate
    ),
  ]
);

/**
 * A break inside one session. Counted to the clock-out instant when the
 * session closes with this still open, so an employee who forgets to end one
 * is not credited the time.
 */
export const attendanceBreaks = pgTable(
  "attendance_breaks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /**
     * The sweep closed this at the break ceiling. The correction dashboard
     * reads it, so an ordinary clock-out over a running break does not set it
     * — that close is recorded on the clock-out's own event instead.
     */
    autoClosed: boolean("auto_closed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // One open break per session, held the same way as the session's own index.
    uniqueIndex("uq_attendance_breaks_open_per_session")
      .on(table.sessionId)
      .where(sql`${table.endedAt} is null`),
    index("idx_attendance_breaks_session_id").on(table.sessionId, table.startedAt),
  ]
);

export enum attendanceEventType {
  ClockIn = "CLOCK_IN",
  ClockOut = "CLOCK_OUT",
  BreakStart = "BREAK_START",
  BreakEnd = "BREAK_END",
}

export const attendanceEventTypeEnum = pgEnum(
  "attendance_event_type",
  enumToPgEnum(attendanceEventType)
);

/**
 * The append-only record behind every session, written in the same transaction
 * as the change it describes — `vacation_events` for attendance. The session
 * row keeps only the current state, which cannot answer who moved a clock-out
 * once a later correction overwrites it.
 *
 * A null `changedByUserId` is the sweep, per `docs/attendance.md`; it is also
 * what a deleted account leaves behind, and the event itself stays either way.
 */
export const attendanceEvents = pgTable(
  "attendance_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: "cascade" }),
    eventType: attendanceEventTypeEnum("event_type").notNull(),
    changedByUserId: text("changed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** The fields the change touched, as they stood before and after it. */
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_attendance_events_session_id").on(table.sessionId, table.createdAt)]
);
