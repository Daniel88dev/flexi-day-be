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
  /** {@link autoClosed}, or still open on a day that has passed — the day to look at. */
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
};

export type AttendanceSummary = { days: AttendanceDay[]; totals: AttendanceTotals };

export type AttendanceCalculationInput = {
  /** Every business date the answer covers, ordered — days without a session included. */
  dates: DateString[];
  sessions: CalculableSession[];
  rules: AttendanceRules;
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

export const computeAttendance = ({
  dates,
  sessions,
  rules,
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
      requiredMinutes: required,
      balanceMinutes:
        upcoming || rules.balanceMode === balanceMode.Monthly ? null : workedMinutes - required,
      upcoming,
      open,
      autoClosed,
      // An open session on today's date is somebody at work, not a mistake.
      flagged: autoClosed || (open && businessDate < today),
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
    },
  };
};
