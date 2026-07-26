import { describe, it, expect } from "vitest";
import { buildSummaryEntries } from "../buildSummary.js";
import { vacationType } from "../../../db/schema/vacation-schema.js";
import type { ReportQuotaRow } from "../types.js";

const quota = (overrides: Partial<ReportQuotaRow> = {}): ReportQuotaRow => ({
  userId: "u1",
  groupId: "g1",
  vacationDays: 20,
  homeOfficeDays: 10,
  carriedOverDays: 3,
  ...overrides,
});

const usage = (overrides: Partial<Parameters<typeof buildSummaryEntries>[1][number]> = {}) => ({
  userId: "u1",
  groupId: "g1",
  vacationType: vacationType.Vacation,
  usedToDate: 5,
  plannedRemaining: 2,
  pending: 1,
  ...overrides,
});

describe("buildSummaryEntries", () => {
  it("joins the vacation allowance to its usage and adds carry-over to the remainder", () => {
    const [vacationEntry] = buildSummaryEntries([quota()], [usage()], []);

    expect(vacationEntry).toMatchObject({
      vacationType: vacationType.Vacation,
      carriedOverDays: 3,
      yearQuota: 20,
      usedToDate: 5,
      plannedRemaining: 2,
      remaining: 16,
    });
  });

  it("does not apply carry-over to the home office allowance", () => {
    const entries = buildSummaryEntries([quota()], [], []);
    const homeOffice = entries.find((e) => e.vacationType === vacationType.HomeOffice);

    expect(homeOffice).toMatchObject({ carriedOverDays: 0, yearQuota: 10, remaining: 10 });
  });

  it("includes members with an allowance but no bookings", () => {
    const entries = buildSummaryEntries([], [], [{ userId: "u9", groupId: "g1" }]);

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.userId === "u9" && e.remaining === 0)).toBe(true);
  });

  it("includes members with bookings but no quota row", () => {
    const entries = buildSummaryEntries([], [usage({ userId: "u2" })], []);
    const vacationEntry = entries.find((e) => e.vacationType === vacationType.Vacation);

    expect(vacationEntry).toMatchObject({ userId: "u2", yearQuota: 0, remaining: -7 });
  });

  it("emits only the quota-bearing types present in the type filter", () => {
    const entries = buildSummaryEntries([quota()], [], [], [vacationType.HomeOffice]);

    expect(entries.map((e) => e.vacationType)).toEqual([vacationType.HomeOffice]);
  });

  it("returns nothing when the type filter excludes both quota-bearing types", () => {
    expect(buildSummaryEntries([quota()], [], [], [vacationType.Sick])).toEqual([]);
  });

  it("keeps a member's groups as separate lines", () => {
    const entries = buildSummaryEntries(
      [quota(), quota({ groupId: "g2", vacationDays: 25, carriedOverDays: 0 })],
      [],
      []
    );

    expect(entries.filter((e) => e.vacationType === vacationType.Vacation)).toHaveLength(2);
  });

  it("rounds a half-day remainder to two decimals rather than a float artefact", () => {
    const entries = buildSummaryEntries(
      [quota({ carriedOverDays: 0, vacationDays: 20 })],
      [usage({ usedToDate: 0.1, plannedRemaining: 0.2 })],
      []
    );
    const vacationEntry = entries.find((e) => e.vacationType === vacationType.Vacation);

    expect(vacationEntry?.remaining).toBe(19.7);
  });
});
