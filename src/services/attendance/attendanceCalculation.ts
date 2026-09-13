import { attendanceClosedBy } from "../../db/schema/attendance-schema.js";
import { balanceMode } from "../../db/schema/organization-attendance-settings-schema.js";
import type { DateString } from "../../utils/dateFunc.js";
import { businessDateInZone } from "../../utils/dateFunc.js";

/**
 * The worked-time and required-time rules of `docs/attendance.md`, worked out
 * from rows rather than reading any. Nothing here touches the database, and
 * nothing here enforces anything: a shortfall is a number, not a refusal.
 *
 * The month endpoint and the team dashboard both call it, so a figure an
 * employee reads and the one their admin reads cannot drift apart.
 */

/** Either end of a stretch of time; null while it is still running. */
type Span = { startedAt: Date; endedAt: Date | null };

export type CalculableBreak = Span & { autoClosed: boolean };

/**
 * What the module needs of a session row — `AttendanceSessionView` satisfies it,
 * and so does a literal in a test.
 */
export type CalculableSession = Span & {
  businessDate: DateString;
  closedBy: attendanceClosedBy | null;
  breaks: CalculableBreak[];
};

export type AttendanceRules = {
  /** Deducted once presence passes the threshold, taken or not. */
  breakMinutes: number;
  breakThresholdMinutes: number;
  requiredMinutesPerDay: number;
  /** The Employment's own required time, when it has one. */
  requiredMinutesOverride: number | null;
  balanceMode: balanceMode;
};

/** Why nothing, or only half, is owed on a business date. */
export enum AttendanceExclusionCause {
  /** The date falls outside this Employment's own spell. */
  NotEmployed = "NOT_EMPLOYED",
  /** Not one of the organization's working days. */
  NonWorkingDay = "NON_WORKING_DAY",
  Holiday = "HOLIDAY",
  Absence = "ABSENCE",
}

/** A whole day off, or half of one — a `halfDay` absence halves the required time. */
export enum AttendanceExclusionExtent {
  Full = "FULL",
  Half = "HALF",
}

export type DayExclusion = {
  cause: AttendanceExclusionCause;
  extent: AttendanceExclusionExtent;
  /** The holiday's name or the absence's type, for the day to say why. Null where the cause is the whole story. */
  label: string | null;
};

export type AttendanceDay = {
  businessDate: DateString;
  presenceMinutes: number;
  /** Break actually taken, which is not always what comes off the day. */
  breaksMinutes: number;
  deductedMinutes: number;
  workedMinutes: number;
  requiredMinutes: number;
  /** Null on an upcoming date, and in `MONTHLY` mode, where the month holds the only balance. */
  balanceMinutes: number | null;
  /** A business date the organization has not reached yet: nothing is owed on it. */
  upcoming: boolean;
  open: boolean;
  /** The sweep closed the session or a break inside it, so a number here is wrong. */
  autoClosed: boolean;
  /** Null on an ordinary working day. */
  exclusion: DayExclusion | null;
  /** Somebody at work on a day nobody owed: allowed, counted, and worth a look. */
  excludedClockIn: boolean;
  /** {@link autoClosed}, {@link excludedClockIn}, or still open on a day that has passed. */
  flagged: boolean;
};

export type AttendanceTotals = {
  presenceMinutes: number;
  workedMinutes: number;
  /**
   * Required over the dates already begun, which is what the balance is
   * measured against — mid-month, the days nobody has worked yet must not read
   * as a shortfall.
   */
  requiredMinutes: number;
  /** Required over every date in the range, upcoming ones included. */
  requiredRangeMinutes: number;
  balanceMinutes: number;
  flaggedDays: number;
  /**
   * Whole days off in the range, upcoming ones included — a weekend is a day
   * off whether or not it has arrived. A half day is not one of them, and
   * neither is `NOT_EMPLOYED`: a date before somebody joined is not a day they
   * were excused from.
   */
  excludedDays: number;
};

export type AttendanceSummary = { days: AttendanceDay[]; totals: AttendanceTotals };

export type AttendanceCalculationInput = {
  /** Every business date the answer covers, ordered — days without a session included. */
  dates: DateString[];
  sessions: CalculableSession[];
  rules: AttendanceRules;
  /** What each date is excused from, keyed by business date; absent means a full working day. */
  exclusions: Map<DateString, DayExclusion>;
  timezone: string;
  now: Date;
};

/**
 * Whole minutes of a span, floored and never negative — the frontend's clock
 * reads the same way, so a running session shows the same figure on both sides.
 */
const spanMinutes = (span: Span, now: Date): number => {
  const end = (span.endedAt ?? now).getTime();
  return Math.max(0, Math.floor((end - span.startedAt.getTime()) / 60_000));
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * What the day owes: nothing when it is excluded outright, half the ordinary
 * figure on a half day. Halving rounds down, so two half days never owe a
 * minute more than the whole one they came from.
 */
const requiredFor = (required: number, exclusion: DayExclusion | undefined): number => {
  if (exclusion === undefined) return required;
  return exclusion.extent === AttendanceExclusionExtent.Half ? Math.floor(required / 2) : 0;
};

export const computeAttendance = ({
  dates,
  sessions,
  rules,
  exclusions,
  timezone,
  now,
}: AttendanceCalculationInput): AttendanceSummary => {
  const today = businessDateInZone(now, timezone);
  const required = rules.requiredMinutesOverride ?? rules.requiredMinutesPerDay;
  const perDate = new Map<DateString, CalculableSession[]>();

  for (const session of sessions) {
    perDate.set(session.businessDate, [...(perDate.get(session.businessDate) ?? []), session]);
  }

  const days = dates.map((businessDate): AttendanceDay => {
    const ofDate = perDate.get(businessDate) ?? [];
    const presenceMinutes = sum(ofDate.map((session) => spanMinutes(session, now)));
    const breaksMinutes = sum(
      ofDate.map((session) => sum(session.breaks.map((entry) => spanMinutes(entry, now))))
    );
    const deductedMinutes =
      presenceMinutes > rules.breakThresholdMinutes
        ? Math.max(rules.breakMinutes, breaksMinutes)
        : breaksMinutes;
    const workedMinutes = Math.max(0, presenceMinutes - deductedMinutes);

    const exclusion = exclusions.get(businessDate);
    const requiredMinutes = requiredFor(required, exclusion);
    const fullyExcluded =
      exclusion !== undefined && exclusion.extent === AttendanceExclusionExtent.Full;
    // A session on a date outside the spell is a rejoiner's old one — the
    // Employment row carries the current spell and the sessions outlive it.
    // The hours happened and still count, but there is nothing to flag: nobody
    // clocked into a day off, and nobody can correct a spell that has closed.
    const outsideTheSpell = exclusion?.cause === AttendanceExclusionCause.NotEmployed;
    const excludedClockIn = fullyExcluded && !outsideTheSpell && presenceMinutes > 0;

    const upcoming = businessDate > today;
    const open = ofDate.some((session) => session.endedAt === null);
    const autoClosed = ofDate.some(
      (session) =>
        session.closedBy === attendanceClosedBy.Sweep ||
        session.breaks.some((entry) => entry.autoClosed)
    );

    return {
      businessDate,
      presenceMinutes,
      breaksMinutes,
      deductedMinutes,
      workedMinutes,
      requiredMinutes,
      // A day off nobody worked has no balance to show; one somebody clocked
      // into does, and it is all surplus.
      balanceMinutes:
        upcoming ||
        rules.balanceMode === balanceMode.Monthly ||
        outsideTheSpell ||
        (fullyExcluded && presenceMinutes === 0)
          ? null
          : workedMinutes - requiredMinutes,
      upcoming,
      open,
      autoClosed,
      exclusion: exclusion ?? null,
      excludedClockIn,
      // An open session on today's date is somebody at work, not a mistake.
      flagged: autoClosed || excludedClockIn || (open && businessDate < today),
    };
  });

  const begun = days.filter((day) => !day.upcoming);
  const workedMinutes = sum(begun.map((day) => day.workedMinutes));
  const requiredMinutes = sum(begun.map((day) => day.requiredMinutes));

  return {
    days,
    totals: {
      presenceMinutes: sum(begun.map((day) => day.presenceMinutes)),
      workedMinutes,
      requiredMinutes,
      requiredRangeMinutes: sum(days.map((day) => day.requiredMinutes)),
      balanceMinutes: workedMinutes - requiredMinutes,
      flaggedDays: days.filter((day) => day.flagged).length,
      excludedDays: days.filter(
        (day) =>
          day.exclusion !== null &&
          day.exclusion.extent === AttendanceExclusionExtent.Full &&
          day.exclusion.cause !== AttendanceExclusionCause.NotEmployed
      ).length,
    },
  };
};
