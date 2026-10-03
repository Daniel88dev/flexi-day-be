import { describe, it, expect } from "vitest";
import { buildSummaryEntries } from "../buildSummary.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import type { ReportQuotaRow } from "../types.js";
import type { GroupAllowancePolicy } from "../../userYearQuotas/types.js";

const quota = (overrides: Partial<ReportQuotaRow> = {}): ReportQuotaRow => ({
  userId: "u1",
  groupId: "g1",
  vacationDays: 20,
  homeOfficeDays: 10,
  sickDays: 4,
  carriedOverDays: 3,
  ...overrides,
});

const usage = (overrides: Partial<Parameters<typeof buildSummaryEntries>[1][number]> = {}) => ({
  userId: "u1",
  groupId: "g1",
  vacationType: CalendarRecordType.Vacation,
  usedToDate: 5,
  plannedRemaining: 2,
  pending: 1,
  ...overrides,
});

const policiesFor = (sickDayGroups: string[] = []): Map<string, GroupAllowancePolicy> =>
  new Map(
    ["g1", "g2"].map((groupId) => [
      groupId,
      {
        defaultVacationDays: 25,
        defaultHomeOfficeDays: 8,
        defaultSickDays: 5,
        sickDayBenefitEnabled: sickDayGroups.includes(groupId),
      },
    ])
  );

const noSickDayGroups = policiesFor();

describe("buildSummaryEntries", () => {
  it("joins the vacation allowance to its usage and adds carry-over to the remainder", () => {
    const [vacationEntry] = buildSummaryEntries([quota()], [usage()], [], noSickDayGroups);

    expect(vacationEntry).toMatchObject({
      vacationType: CalendarRecordType.Vacation,
      carriedOverDays: 3,
      yearQuota: 20,
      usedToDate: 5,
      plannedRemaining: 2,
      remaining: 16,
    });
  });

  it("does not apply carry-over to the home office allowance", () => {
    const entries = buildSummaryEntries([quota()], [], [], noSickDayGroups);
    const homeOffice = entries.find((e) => e.vacationType === CalendarRecordType.HomeOffice);

    expect(homeOffice).toMatchObject({ carriedOverDays: 0, yearQuota: 10, remaining: 10 });
  });

  it("gives a member with no quota row and no bookings the group defaults", () => {
    const entries = buildSummaryEntries([], [], [{ userId: "u9", groupId: "g1" }], noSickDayGroups);

    expect(entries).toEqual([
      expect.objectContaining({
        userId: "u9",
        vacationType: CalendarRecordType.Vacation,
        carriedOverDays: 0,
        yearQuota: 25,
        remaining: 25,
      }),
      expect.objectContaining({
        userId: "u9",
        vacationType: CalendarRecordType.HomeOffice,
        yearQuota: 8,
        remaining: 8,
      }),
    ]);
  });

  it("draws a member's bookings against the group default when they have no quota row", () => {
    const entries = buildSummaryEntries([], [usage({ userId: "u2" })], [], noSickDayGroups);
    const vacationEntry = entries.find((e) => e.vacationType === CalendarRecordType.Vacation);

    expect(vacationEntry).toMatchObject({
      userId: "u2",
      carriedOverDays: 0,
      yearQuota: 25,
      remaining: 18,
    });
  });

  it("gives a missing quota row the group's sick day default where the benefit is on", () => {
    const entries = buildSummaryEntries(
      [],
      [],
      [{ userId: "u9", groupId: "g1" }],
      policiesFor(["g1"])
    );

    expect(entries.find((e) => e.vacationType === CalendarRecordType.SickDay)).toMatchObject({
      yearQuota: 5,
      carriedOverDays: 0,
      remaining: 5,
    });
  });

  it("allocates nothing for a group it has no policy for", () => {
    const entries = buildSummaryEntries([], [usage({ userId: "u2" })], [], new Map());
    const vacationEntry = entries.find((e) => e.vacationType === CalendarRecordType.Vacation);

    expect(vacationEntry).toMatchObject({ yearQuota: 0, remaining: -7 });
  });

  it("emits only the quota-bearing types present in the type filter", () => {
    const entries = buildSummaryEntries([quota()], [], [], noSickDayGroups, [
      CalendarRecordType.HomeOffice,
    ]);

    expect(entries.map((e) => e.vacationType)).toEqual([CalendarRecordType.HomeOffice]);
  });

  it("returns nothing when the type filter excludes every quota-bearing type", () => {
    expect(
      buildSummaryEntries([quota()], [], [], noSickDayGroups, [CalendarRecordType.Sick])
    ).toEqual([]);
  });

  it("keeps a member's groups as separate lines", () => {
    const entries = buildSummaryEntries(
      [quota(), quota({ groupId: "g2", vacationDays: 25, carriedOverDays: 0 })],
      [],
      [],
      noSickDayGroups
    );

    expect(entries.filter((e) => e.vacationType === CalendarRecordType.Vacation)).toHaveLength(2);
  });

  it("rounds a half-day remainder to two decimals rather than a float artefact", () => {
    const entries = buildSummaryEntries(
      [quota({ carriedOverDays: 0, vacationDays: 20 })],
      [usage({ usedToDate: 0.1, plannedRemaining: 0.2 })],
      [],
      noSickDayGroups
    );
    const vacationEntry = entries.find((e) => e.vacationType === CalendarRecordType.Vacation);

    expect(vacationEntry?.remaining).toBe(19.7);
  });

  it("emits a sick day line only for groups with the benefit, without carry-over", () => {
    const entries = buildSummaryEntries(
      [quota(), quota({ groupId: "g2", sickDays: 2 })],
      [
        usage({
          vacationType: CalendarRecordType.SickDay,
          usedToDate: 1,
          plannedRemaining: 0,
          pending: 0,
        }),
      ],
      [],
      policiesFor(["g1"])
    );

    const sickDayEntries = entries.filter((e) => e.vacationType === CalendarRecordType.SickDay);
    expect(sickDayEntries).toHaveLength(1);
    expect(sickDayEntries[0]).toMatchObject({
      groupId: "g1",
      carriedOverDays: 0,
      yearQuota: 4,
      usedToDate: 1,
      remaining: 3,
    });
  });

  it("emits no sick day lines when no group has the benefit", () => {
    const entries = buildSummaryEntries([quota()], [], [], noSickDayGroups);

    expect(entries.some((e) => e.vacationType === CalendarRecordType.SickDay)).toBe(false);
  });
});
