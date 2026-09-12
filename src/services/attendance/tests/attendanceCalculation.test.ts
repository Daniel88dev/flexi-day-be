import { describe, it, expect } from "vitest";
import { balanceMode } from "../../../db/schema/organization-attendance-settings-schema.js";
import { attendanceClosedBy } from "../../../db/schema/attendance-schema.js";
import {
  AttendanceExclusionCause,
  AttendanceExclusionExtent,
  computeAttendance,
  type AttendanceRules,
  type CalculableSession,
  type DayExclusion,
} from "../attendanceCalculation.js";
import { expandDateRangeInclusive } from "../../../utils/dateFunc.js";

const PRAGUE = "Europe/Prague";

const rules = (overrides: Partial<AttendanceRules> = {}): AttendanceRules => ({
  breakMinutes: 30,
  breakThresholdMinutes: 360,
  requiredMinutesPerDay: 480,
  requiredMinutesOverride: null,
  balanceMode: balanceMode.Daily,
  ...overrides,
});

/** A closed session on one business date, times given in the organization's zone. */
const session = (
  businessDate: string,
  startedAt: string,
  endedAt: string | null,
  breaks: [string, string | null][] = [],
  overrides: Partial<CalculableSession> = {}
): CalculableSession => ({
  businessDate,
  startedAt: new Date(startedAt),
  endedAt: endedAt === null ? null : new Date(endedAt),
  closedBy: endedAt === null ? null : attendanceClosedBy.User,
  breaks: breaks.map(([from, to]) => ({
    startedAt: new Date(from),
    endedAt: to === null ? null : new Date(to),
    autoClosed: false,
  })),
  ...overrides,
});

const compute = (input: {
  dates: string[];
  sessions?: CalculableSession[];
  rules?: AttendanceRules;
  exclusions?: Record<string, DayExclusion>;
  now?: Date;
}) =>
  computeAttendance({
    dates: input.dates,
    sessions: input.sessions ?? [],
    rules: input.rules ?? rules(),
    exclusions: new Map(Object.entries(input.exclusions ?? {})),
    timezone: PRAGUE,
    now: input.now ?? new Date("2026-09-30T23:00:00Z"),
  });

describe("computeAttendance", () => {
  it("deducts the breaks taken and nothing else below the threshold", () => {
    // 09:00–13:30 local is 4:30 of presence, under the six-hour threshold, with
    // a 15 minute break inside it.
    const { days } = compute({
      dates: ["2026-09-07"],
      sessions: [
        session("2026-09-07", "2026-09-07T07:00:00Z", "2026-09-07T11:30:00Z", [
          ["2026-09-07T09:00:00Z", "2026-09-07T09:15:00Z"],
        ]),
      ],
    });

    expect(days[0]).toMatchObject({
      presenceMinutes: 270,
      breaksMinutes: 15,
      deductedMinutes: 15,
      workedMinutes: 255,
      requiredMinutes: 480,
      balanceMinutes: -225,
    });
  });

  it("deducts the whole allowance above the threshold when less break was taken", () => {
    const { days } = compute({
      dates: ["2026-09-07"],
      sessions: [
        session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T15:00:00Z", [
          ["2026-09-07T10:00:00Z", "2026-09-07T10:10:00Z"],
        ]),
      ],
    });

    expect(days[0]).toMatchObject({
      presenceMinutes: 540,
      breaksMinutes: 10,
      deductedMinutes: 30,
      workedMinutes: 510,
    });
  });

  it("deducts a break longer than the allowance in full", () => {
    const { days } = compute({
      dates: ["2026-09-07"],
      sessions: [
        session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T15:00:00Z", [
          ["2026-09-07T10:00:00Z", "2026-09-07T11:30:00Z"],
        ]),
      ],
    });

    expect(days[0]).toMatchObject({ deductedMinutes: 90, workedMinutes: 450 });
  });

  it("charges no allowance on a day of exactly the threshold", () => {
    const { days } = compute({
      dates: ["2026-09-07"],
      sessions: [session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T12:00:00Z")],
    });

    expect(days[0]).toMatchObject({ presenceMinutes: 360, deductedMinutes: 0, workedMinutes: 360 });
  });

  it("counts an open session and an open break up to now", () => {
    const { days } = compute({
      dates: ["2026-09-11"],
      sessions: [
        session("2026-09-11", "2026-09-11T06:00:00Z", null, [["2026-09-11T09:00:00Z", null]]),
      ],
      now: new Date("2026-09-11T09:20:00Z"),
    });

    expect(days[0]).toMatchObject({
      presenceMinutes: 200,
      breaksMinutes: 20,
      deductedMinutes: 20,
      workedMinutes: 180,
      open: true,
    });
  });

  it("takes the Employment's override over the organization's required time", () => {
    const { days, totals } = compute({
      dates: ["2026-09-07"],
      sessions: [session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T10:00:00Z")],
      rules: rules({ requiredMinutesOverride: 240 }),
    });

    expect(days[0]).toMatchObject({ requiredMinutes: 240, workedMinutes: 240, balanceMinutes: 0 });
    expect(totals).toMatchObject({ requiredMinutes: 240, balanceMinutes: 0 });
  });

  it("leaves the per-day balance out in MONTHLY mode and keeps the month's", () => {
    const input = {
      dates: ["2026-09-07", "2026-09-08"],
      sessions: [
        session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T14:00:00Z"),
        session("2026-09-08", "2026-09-08T06:00:00Z", "2026-09-08T15:00:00Z"),
      ],
    };

    const daily = compute(input);
    const monthly = compute({ ...input, rules: rules({ balanceMode: balanceMode.Monthly }) });

    // 8:00 of presence less the allowance is 0:30 short; 9:00 is 0:30 over.
    expect(daily.days.map((day) => day.balanceMinutes)).toEqual([-30, 30]);
    expect(monthly.days.map((day) => day.balanceMinutes)).toEqual([null, null]);
    expect(monthly.totals.balanceMinutes).toBe(0);
    expect(daily.totals.balanceMinutes).toBe(0);
  });

  it("counts a session that crosses midnight wholly on the business date it started", () => {
    const { days } = compute({
      dates: ["2026-09-07", "2026-09-08"],
      sessions: [session("2026-09-07", "2026-09-07T20:00:00Z", "2026-09-08T04:00:00Z")],
    });

    expect(days[0]).toMatchObject({ businessDate: "2026-09-07", presenceMinutes: 480 });
    expect(days[1]).toMatchObject({ businessDate: "2026-09-08", presenceMinutes: 0 });
  });

  it("counts the real hours across a spring-forward, not the wall clock", () => {
    // Europe/Prague loses an hour at 02:00 on 29 March 2026. A night shift from
    // 23:00 to 07:00 reads as eight hours on the wall clock and is seven.
    const { days } = compute({
      dates: ["2026-03-28"],
      sessions: [session("2026-03-28", "2026-03-28T22:00:00Z", "2026-03-29T05:00:00Z")],
      now: new Date("2026-03-30T12:00:00Z"),
    });

    expect(days[0]).toMatchObject({
      presenceMinutes: 420,
      deductedMinutes: 30,
      workedMinutes: 390,
    });
  });

  it("decides which dates are still to come in the organization's zone, either side of a DST change", () => {
    // 23:30 UTC on 28 March 2026 is already half past midnight on the 29th in
    // Prague, which is still UTC+1; 22:30 UTC on the 29th is half past midnight
    // on the 30th, by when the clocks have gone forward to UTC+2. A fixed
    // offset gets one of the two wrong.
    const dates = ["2026-03-28", "2026-03-29", "2026-03-30"];

    const beforeTheChange = compute({ dates, now: new Date("2026-03-28T23:30:00Z") });
    expect(beforeTheChange.days.map((day) => day.upcoming)).toEqual([false, false, true]);

    const afterIt = compute({ dates, now: new Date("2026-03-29T22:30:00Z") });
    expect(afterIt.days.map((day) => day.upcoming)).toEqual([false, false, false]);
  });

  it("owes nothing on a date later than today and keeps it out of the balance", () => {
    const { days, totals } = compute({
      dates: ["2026-09-10", "2026-09-11", "2026-09-12"],
      sessions: [session("2026-09-10", "2026-09-10T06:00:00Z", "2026-09-10T14:30:00Z")],
      now: new Date("2026-09-11T09:00:00Z"),
    });

    expect(days.map((day) => day.upcoming)).toEqual([false, false, true]);
    expect(days[2]).toMatchObject({ requiredMinutes: 480, balanceMinutes: null });
    expect(totals).toMatchObject({
      workedMinutes: 480,
      requiredMinutes: 960,
      requiredRangeMinutes: 1440,
      balanceMinutes: -480,
    });
  });

  it("totals the month and counts the days that need a correction", () => {
    const swept = session("2026-09-01", "2026-09-01T06:00:00Z", "2026-09-01T22:00:00Z", [], {
      closedBy: attendanceClosedBy.Sweep,
    });
    const stillOpen = session("2026-09-02", "2026-09-02T06:00:00Z", null);
    const ordinary = session("2026-09-03", "2026-09-03T06:00:00Z", "2026-09-03T14:30:00Z");

    const { days, totals } = compute({
      dates: expandDateRangeInclusive("2026-09-01", "2026-09-30"),
      sessions: [swept, stillOpen, ordinary],
      now: new Date("2026-09-03T16:00:00Z"),
    });

    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ autoClosed: true, flagged: true });
    expect(days[1]).toMatchObject({ open: true, flagged: true });
    expect(days[2]).toMatchObject({ flagged: false });
    // The session still open from the 2nd has been running for 34 hours, which
    // is what an uncorrected day looks like and why it is flagged.
    expect(totals).toMatchObject({
      presenceMinutes: 960 + 2040 + 510,
      workedMinutes: 930 + 2010 + 480,
      requiredMinutes: 1440,
      requiredRangeMinutes: 14400,
      flaggedDays: 2,
    });
    expect(totals.balanceMinutes).toBe(930 + 2010 + 480 - 1440);
  });
});

describe("computeAttendance, excluded days", () => {
  const excluded = (
    cause: AttendanceExclusionCause,
    label: string | null = null,
    extent: AttendanceExclusionExtent = AttendanceExclusionExtent.Full
  ): DayExclusion => ({ cause, extent, label });

  it("owes nothing on a date the organization does not work", () => {
    const { days } = compute({
      dates: ["2026-09-05"],
      exclusions: { "2026-09-05": excluded(AttendanceExclusionCause.NonWorkingDay) },
    });

    expect(days[0]).toMatchObject({
      requiredMinutes: 0,
      workedMinutes: 0,
      balanceMinutes: null,
      exclusion: { cause: "NON_WORKING_DAY", extent: "FULL", label: null },
    });
  });

  it("carries the holiday's own name, so the day says why", () => {
    const { days } = compute({
      dates: ["2026-09-28"],
      exclusions: {
        "2026-09-28": excluded(AttendanceExclusionCause.Holiday, "Den české státnosti"),
      },
    });

    expect(days[0]).toMatchObject({
      requiredMinutes: 0,
      exclusion: { cause: "HOLIDAY", extent: "FULL", label: "Den české státnosti" },
    });
  });

  it("owes nothing on an approved absence and names its type", () => {
    const { days } = compute({
      dates: ["2026-09-21"],
      exclusions: { "2026-09-21": excluded(AttendanceExclusionCause.Absence, "VACATION") },
    });

    expect(days[0]).toMatchObject({
      requiredMinutes: 0,
      exclusion: { cause: "ABSENCE", label: "VACATION" },
    });
  });

  it("halves the required time for a half day rather than excluding it", () => {
    const { days, totals } = compute({
      dates: ["2026-09-08"],
      sessions: [session("2026-09-08", "2026-09-08T06:00:00Z", "2026-09-08T10:10:00Z")],
      exclusions: {
        "2026-09-08": excluded(
          AttendanceExclusionCause.Absence,
          "VACATION",
          AttendanceExclusionExtent.Half
        ),
      },
    });

    expect(days[0]).toMatchObject({
      requiredMinutes: 240,
      workedMinutes: 250,
      balanceMinutes: 10,
      exclusion: { extent: "HALF" },
    });
    // Half a day off is not a day off: the month's count is of whole ones.
    expect(totals.excludedDays).toBe(0);
  });

  it("halves an overridden required time, not the organization's", () => {
    const { days } = compute({
      dates: ["2026-09-08"],
      rules: rules({ requiredMinutesOverride: 360 }),
      exclusions: {
        "2026-09-08": excluded(
          AttendanceExclusionCause.Absence,
          "SICK_DAY",
          AttendanceExclusionExtent.Half
        ),
      },
    });

    expect(days[0]).toMatchObject({ requiredMinutes: 180 });
  });

  it("counts a clock-in on an excluded day and flags it", () => {
    const { days, totals } = compute({
      dates: ["2026-09-05"],
      sessions: [session("2026-09-05", "2026-09-05T07:00:00Z", "2026-09-05T09:10:00Z")],
      exclusions: { "2026-09-05": excluded(AttendanceExclusionCause.NonWorkingDay) },
    });

    expect(days[0]).toMatchObject({
      presenceMinutes: 130,
      workedMinutes: 130,
      requiredMinutes: 0,
      balanceMinutes: 130,
      excludedClockIn: true,
      flagged: true,
    });
    expect(totals.workedMinutes).toBe(130);
    expect(totals.flaggedDays).toBe(1);
  });

  it("owes nothing on a date outside the employment's own spell, and leaves it out of the count", () => {
    const { days, totals } = compute({
      dates: expandDateRangeInclusive("2026-09-01", "2026-09-07"),
      sessions: [session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T14:30:00Z")],
      exclusions: {
        "2026-09-01": excluded(AttendanceExclusionCause.NotEmployed),
        "2026-09-02": excluded(AttendanceExclusionCause.NotEmployed),
        "2026-09-03": excluded(AttendanceExclusionCause.NotEmployed),
        "2026-09-04": excluded(AttendanceExclusionCause.NotEmployed),
        "2026-09-05": excluded(AttendanceExclusionCause.NonWorkingDay),
        "2026-09-06": excluded(AttendanceExclusionCause.NonWorkingDay),
      },
    });

    expect(days.slice(0, 4).map((day) => day.requiredMinutes)).toEqual([0, 0, 0, 0]);
    expect(days.slice(0, 4).map((day) => day.balanceMinutes)).toEqual([null, null, null, null]);
    // Only Monday is owed, and only the weekend counts as a day off — the four
    // days before the person joined are not days they did not have to work.
    expect(totals).toMatchObject({
      requiredMinutes: 480,
      requiredRangeMinutes: 480,
      workedMinutes: 480,
      balanceMinutes: 0,
      excludedDays: 2,
    });
  });

  it("keeps a rejoiner's older session without a balance or a flag against it", () => {
    const { days, totals } = compute({
      dates: ["2026-09-07"],
      sessions: [session("2026-09-07", "2026-09-07T06:00:00Z", "2026-09-07T10:00:00Z")],
      exclusions: { "2026-09-07": excluded(AttendanceExclusionCause.NotEmployed) },
    });

    expect(days[0]).toMatchObject({
      workedMinutes: 240,
      requiredMinutes: 0,
      balanceMinutes: null,
      excludedClockIn: false,
      flagged: false,
    });
    expect(totals.workedMinutes).toBe(240);
  });

  it("keeps the required time of an upcoming date that nobody is excused from", () => {
    const { days, totals } = compute({
      dates: ["2026-09-11", "2026-09-12"],
      exclusions: { "2026-09-12": excluded(AttendanceExclusionCause.NonWorkingDay) },
      now: new Date("2026-09-11T09:00:00Z"),
    });

    expect(days[1]).toMatchObject({ upcoming: true, requiredMinutes: 0 });
    expect(totals.requiredRangeMinutes).toBe(480);
    // The weekend is a day off whether or not it has arrived.
    expect(totals.excludedDays).toBe(1);
  });
});
