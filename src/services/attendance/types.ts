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

export type AttendanceSessionType = {
  id: string;
  employmentId: string;
  businessDate: DateString;
  startedAt: Date;
  endedAt: Date | null;
  timezone: string;
  closedBy: attendanceClosedBy | null;
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
