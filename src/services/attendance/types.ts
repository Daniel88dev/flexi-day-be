import { z } from "zod";
import type {
  attendanceClosedBy,
  attendanceEventType,
  attendanceSessionOrigin,
} from "../../db/schema/attendance-schema.js";
import type { balanceMode } from "../../db/schema/organization-attendance-settings-schema.js";
import type { AttendanceDay, AttendanceTotals } from "./attendanceCalculation.js";
import type { DateString } from "../../utils/dateFunc.js";
import type { SelfServiceWindow } from "./selfServiceWindow.js";
import type { UserSummary } from "../../utils/userPresentation.js";

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
  origin: attendanceSessionOrigin;
  /** Who entered it, from its `SESSION_CREATED` event; null for a clocked session. */
  enteredByUserId: string | null;
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
  selfService: SelfServiceWindow;
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

/**
 * One person's one business date — what the correction dialog opens onto. The
 * organization is required and `userId` defaults to the caller, so an admin
 * names the person and an employee names nobody. Who may read it is the
 * visibility matrix, unlike {@link validateAttendanceMonthQuery}, which refuses
 * anyone but its subject: a day is exactly what an admin came to the team
 * dashboard to look at.
 */
export const validateAttendanceDayQuery = z.object({
  // better-auth user ids are opaque non-UUID strings.
  organizationId: z.string().min(1),
  userId: z.string().min(1).optional(),
  businessDate: z.iso.date(),
});

export type ValidatedAttendanceDayQueryType = z.infer<typeof validateAttendanceDayQuery>;

/** One person's sessions on one business date, with the zone they read in. */
export type AttendanceDayType = {
  organizationId: string;
  employmentId: string;
  userId: string;
  businessDate: DateString;
  timezone: string | null;
  sessions: AttendanceSessionView[];
};

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

/**
 * The longest range the team dashboard answers for: a quarter, with a day to
 * spare. Every person costs a computation over every date, and a year of a
 * whole organization is a report, not a screen.
 */
export const TEAM_RANGE_MAX_DAYS = 93;

const daysInclusive = (from: DateString, to: DateString): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * The team dashboard's scope. `organizationId` is required here where the
 * caller's own reads default it: an admin may administer groups in several
 * organizations, and nothing about them says which one they mean.
 */
export const validateAttendanceTeamQuery = z
  .object({
    // better-auth user ids and group ids are opaque non-UUID strings.
    organizationId: z.string().min(1),
    groupId: z.string().min(1).optional(),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((query) => query.from <= query.to, {
    message: "The range ends before it starts",
    path: ["to"],
  })
  .refine((query) => daysInclusive(query.from, query.to) <= TEAM_RANGE_MAX_DAYS, {
    message: `The range may cover at most ${TEAM_RANGE_MAX_DAYS} days`,
    path: ["to"],
  });

export type ValidatedAttendanceTeamQueryType = z.infer<typeof validateAttendanceTeamQuery>;

export type AttendanceTeamGroup = { id: string; groupName: string };

/** One row of the dashboard: a person, their days in the range, and the range's totals. */
export type AttendanceTeamPerson = {
  employmentId: string;
  userId: string;
  user: UserSummary;
  /** The organization's live groups this person belongs to, by name. A manager's may be empty. */
  groups: AttendanceTeamGroup[];
  /** What their days were measured against: the override where there is one. */
  requiredMinutesPerDay: number;
  requiredMinutesOverride: number | null;
  days: AttendanceDay[];
  totals: AttendanceTotals;
};

/** Somebody clocked in right now, whichever business date the session belongs to. */
export type AttendanceTeamOpenSession = {
  employmentId: string;
  userId: string;
  sessionId: string;
  businessDate: DateString;
  startedAt: Date;
  onBreak: boolean;
  breakStartedAt: Date | null;
};

/** Whether the viewer sees the whole organization or only their groups' members. */
export enum AttendanceTeamScope {
  Organization = "ORGANIZATION",
  Groups = "GROUPS",
}

export type AttendanceTeamType = {
  organizationId: string;
  timezone: string | null;
  businessDate: DateString | null;
  from: DateString;
  to: DateString;
  balanceMode: balanceMode;
  /** The organization's figure; a row carries its own where it differs. */
  requiredMinutesPerDay: number;
  breakMinutes: number;
  breakThresholdMinutes: number;
  selfService: SelfServiceWindow;
  scope: AttendanceTeamScope;
  /** The group the answer was narrowed to, null for the viewer's whole audience. */
  group: AttendanceTeamGroup | null;
  people: AttendanceTeamPerson[];
  inNow: AttendanceTeamOpenSession[];
};

/**
 * A correction to one end of a session or a break. Both keys are optional and
 * an absent one is left alone, but `endedAt: null` is a change of its own —
 * reopening what was closed — so the two cases cannot be collapsed.
 *
 * Instants travel as ISO strings with an offset, unlike the clock itself, whose
 * instant is always the server's. A correction is by definition about a time
 * that has already passed, and only the client knows which one the person meant.
 */
export const validateAttendanceCorrection = z
  .object({
    startedAt: z.iso.datetime({ offset: true }).optional(),
    endedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((patch) => patch.startedAt !== undefined || "endedAt" in patch, {
    message: "A correction has to change something",
  });

export type ValidatedAttendanceCorrectionType = z.infer<typeof validateAttendanceCorrection>;

export const validateAttendanceEntry = z.object({
  organizationId: z.string().min(1),
  // better-auth user ids are opaque non-UUID strings.
  userId: z.string().min(1).optional(),
  businessDate: z.iso.date(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
});

export type ValidatedAttendanceEntryType = z.infer<typeof validateAttendanceEntry>;

/**
 * Whose authority a correction is being made under: an admin over somebody's
 * Employment, or the person themselves inside the self-service window.
 */
export enum AttendanceCorrectionRight {
  Admin = "ADMIN",
  Self = "SELF",
}

/** One entry of a session's timeline, with the person behind it where there was one. */
export type AttendanceEventView = {
  id: string;
  sessionId: string;
  eventType: attendanceEventType;
  /** Null is the sweep, or an account that has since gone. */
  user: UserSummary | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
};
