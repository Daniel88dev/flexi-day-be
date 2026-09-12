import { z } from "zod";
import type { attendanceClosedBy } from "../../db/schema/attendance-schema.js";
import type { balanceMode } from "../../db/schema/organization-attendance-settings-schema.js";
import type { AttendanceDay, AttendanceTotals } from "./attendanceCalculation.js";
import type { DateString } from "../../utils/dateFunc.js";

export type AttendanceBreakType = {
  id: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  autoClosed: boolean;
};

/** Which end of a session a fix belongs to. */
export enum AttendanceSessionEnd {
  In = "IN",
  Out = "OUT",
}

/** Where one end of a session happened. Null throughout until a fix lands. */
export type AttendanceLocation = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
};

export type AttendanceSessionType = {
  id: string;
  employmentId: string;
  businessDate: DateString;
  startedAt: Date;
  endedAt: Date | null;
  timezone: string;
  closedBy: attendanceClosedBy | null;
  startLatitude: number | null;
  startLongitude: number | null;
  startAccuracy: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
  endAccuracy: number | null;
};

/** A session with the breaks taken inside it, oldest first — what the day view renders. */
export type AttendanceSessionView = AttendanceSessionType & { breaks: AttendanceBreakType[] };

/**
 * Everything the clock widget needs in one read: whether there is anything to
 * click, what clicking it would do next, and the day so far.
 */
export type AttendanceStateType = {
  organizationId: string;
  employmentId: string;
  /** Employed here once, not any more — history stays readable, writes are refused. */
  employmentEnded: boolean;
  active: boolean;
  locationEnabled: boolean;
  /** The organization's zone, and today in it. Null when attendance was never set up. */
  timezone: string | null;
  businessDate: DateString | null;
  openSession: AttendanceSessionView | null;
  openBreak: AttendanceBreakType | null;
  sessions: AttendanceSessionView[];
  /**
   * The most recent session the sweep touched, today or yesterday — the one
   * thing on the widget that asks to be corrected rather than clicked. It is
   * either a session the sweep closed or one holding a break it closed, so it
   * may still be open and may read `closedBy: USER`.
   */
  autoClosedSession: AttendanceSessionView | null;
};

/**
 * Every attendance endpoint names its organization the way the employment ones
 * do, and for the same reason — an employee may hold several Employments and
 * administers none. Omitting it resolves the caller's own, which is what the
 * widget does on first load before it has been told which organization it is
 * clocking into.
 */
export const validateAttendanceScope = z
  .object({
    organizationId: z.string().min(1).optional(),
  })
  // The writes take no other field, so their bodies are usually absent
  // entirely. Without this the middleware would 422 every one of them.
  .default({});

export type ValidatedAttendanceScopeType = z.infer<typeof validateAttendanceScope>;

/** How long after a clock a fix may still be attached to it. */
export const LOCATION_WINDOW_MS = 2 * 60 * 1000;

/** How long coordinates outlive the business date they were taken on. */
export const LOCATION_RETENTION_MONTHS = 12;

/**
 * One fix from `navigator.geolocation`. `accuracy` is the radius in metres the
 * browser reports, so smaller is better — the update is refused when it does
 * not beat what is already stored.
 */
export const validateAttendanceLocation = z.object({
  end: z.enum(AttendanceSessionEnd),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().finite(),
});

export type ValidatedAttendanceLocationType = z.infer<typeof validateAttendanceLocation>;

/**
 * What the update did. `applied: false` is the ordinary answer to a fix that
 * arrived too late or no better than the last one, not an error — the browser
 * fires two of these per clock and neither is worth telling the person about.
 */
export type AttendanceLocationResult = AttendanceLocation & {
  applied: boolean;
  end: AttendanceSessionEnd;
};

/**
 * The month view's range. Year and month travel in the query string, so they
 * arrive as strings and are coerced; `organizationId` is optional for the same
 * reason as {@link validateAttendanceScope}.
 *
 * `userId` is accepted only so that naming somebody else can be refused. The
 * caller would otherwise be shown their own month while believing they were
 * reading a colleague's — an admin reads one through the team dashboard, which
 * carries the visibility matrix.
 */
export const validateAttendanceMonthQuery = z.object({
  organizationId: z.string().min(1).optional(),
  // better-auth user ids are opaque non-UUID strings.
  userId: z.string().min(1).optional(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export type ValidatedAttendanceMonthQueryType = z.infer<typeof validateAttendanceMonthQuery>;

/** One business date of the month: the figures, and the rows they were worked out from. */
export type AttendanceMonthDay = AttendanceDay & { sessions: AttendanceSessionView[] };

/**
 * A month of one Employment's attendance. The rules travel with it — the
 * screen prints "of 8:00" and colours against the balance mode, and neither is
 * readable by an employee anywhere else.
 */
export type AttendanceMonthType = {
  organizationId: string;
  employmentId: string;
  /** The zone the days are counted in, null for an organization that never set attendance up. */
  timezone: string | null;
  /** Today in that zone, so the screen knows which day is live without a second clock. */
  businessDate: DateString | null;
  year: number;
  month: number;
  balanceMode: balanceMode;
  /** What the day is measured against: the override where there is one. */
  requiredMinutesPerDay: number;
  /** Null unless this Employment overrides the organization's figure. */
  requiredMinutesOverride: number | null;
  breakMinutes: number;
  breakThresholdMinutes: number;
  days: AttendanceMonthDay[];
  totals: AttendanceTotals;
};
