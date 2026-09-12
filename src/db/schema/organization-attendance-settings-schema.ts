import { boolean, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organization-schema.js";
import { enumToPgEnum } from "../../utils/enumToPgEnum.js";

export enum balanceMode {
  Daily = "DAILY",
  Monthly = "MONTHLY",
}

export const balanceModeEnum = pgEnum("balance_mode", enumToPgEnum(balanceMode));

/**
 * What an organization with no row has, and the source of the column defaults
 * below — the Zod schema and the get endpoint read this rather than repeating
 * the numbers.
 */
export const ATTENDANCE_SETTINGS_DEFAULTS = {
  attendanceEnabled: false,
  locationEnabled: false,
  timezone: null,
  holidayCountry: null,
  workingDays: [1, 2, 3, 4, 5],
  breakMinutes: 30,
  breakThresholdMinutes: 360,
  requiredMinutesPerDay: 480,
  balanceMode: balanceMode.Daily,
  sessionCeilingMinutes: 960,
  breakCeilingMinutes: 120,
};

/**
 * One row per organization, written on the first save. A missing row means
 * attendance was never set up, and every reader treats that as
 * {@link ATTENDANCE_SETTINGS_DEFAULTS} — the `subscriptions` precedent.
 *
 * The organization carries its own timezone, holiday country and working days
 * rather than reading a group's, because an Employment is not group-shaped
 * ([`docs/attendance.md`](../../../docs/attendance.md)). `attendanceEnabled`
 * alone does not make attendance usable: `isAttendanceActive` derives that
 * from the live plan at read time, so a lapse goes dormant without touching
 * this row.
 */
export const organizationAttendanceSettings = pgTable("organization_attendance_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  attendanceEnabled: boolean("attendance_enabled")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.attendanceEnabled),
  locationEnabled: boolean("location_enabled")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.locationEnabled),
  // No default: the zone fixes the business date, so enabling without one
  // would silently pick a day boundary nobody chose.
  timezone: text("timezone"),
  holidayCountry: text("holiday_country"),
  // `Date.getUTCDay()` numbers (0=Sun … 6=Sat), the shape groups already use.
  workingDays: integer("working_days")
    .array()
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.workingDays),
  breakMinutes: integer("break_minutes")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.breakMinutes),
  breakThresholdMinutes: integer("break_threshold_minutes")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.breakThresholdMinutes),
  requiredMinutesPerDay: integer("required_minutes_per_day")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.requiredMinutesPerDay),
  balanceMode: balanceModeEnum("balance_mode")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.balanceMode),
  sessionCeilingMinutes: integer("session_ceiling_minutes")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes),
  breakCeilingMinutes: integer("break_ceiling_minutes")
    .notNull()
    .default(ATTENDANCE_SETTINGS_DEFAULTS.breakCeilingMinutes),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
