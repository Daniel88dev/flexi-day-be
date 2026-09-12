import { z } from "zod";
import type { attendanceClosedBy } from "../../db/schema/attendance-schema.js";
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
