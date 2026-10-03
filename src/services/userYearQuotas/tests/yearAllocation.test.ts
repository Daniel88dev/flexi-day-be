import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUserYearQuotasForGroups, mockGetGroupAllowancePolicies } = vi.hoisted(() => ({
  mockGetUserYearQuotasForGroups: vi.fn(),
  mockGetGroupAllowancePolicies: vi.fn(),
}));

vi.mock("../userYearQuotasServices.js", () => ({
  getUserYearQuotasForGroups: mockGetUserYearQuotasForGroups,
}));

vi.mock("../../group/groupServices.js", () => ({
  getGroupAllowancePolicies: mockGetGroupAllowancePolicies,
}));

import {
  allowanceFor,
  getMemberYearAllocation,
  getMemberYearAllocations,
  resolveYearAllocation,
  totalAllowance,
} from "../yearAllocation.js";
import type { GroupAllowancePolicy } from "../types.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";

const policy = (overrides: Partial<GroupAllowancePolicy> = {}): GroupAllowancePolicy => ({
  defaultVacationDays: 25,
  defaultHomeOfficeDays: 10,
  defaultSickDays: 3,
  sickDayBenefitEnabled: true,
  ...overrides,
});

const row = {
  vacationDays: 20,
  homeOfficeDays: 5,
  sickDays: 2,
  carriedOverDays: 4,
};

describe("resolveYearAllocation", () => {
  it("returns the member's own quota row when there is one", () => {
    expect(resolveYearAllocation(row, policy())).toEqual(row);
  });

  it("falls back to the group defaults with nothing carried over when the row is missing", () => {
    expect(resolveYearAllocation(undefined, policy())).toEqual({
      vacationDays: 25,
      homeOfficeDays: 10,
      sickDays: 3,
      carriedOverDays: 0,
    });
  });

  it("allocates nothing when neither a row nor a live group exists", () => {
    expect(resolveYearAllocation(undefined, undefined)).toEqual({
      vacationDays: 0,
      homeOfficeDays: 0,
      sickDays: 0,
      carriedOverDays: 0,
    });
  });
});

describe("allowanceFor", () => {
  it("gives vacation its year quota plus the carry-over", () => {
    expect(allowanceFor(row, CalendarRecordType.Vacation, policy())).toEqual({
      yearQuota: 20,
      carriedOverDays: 4,
    });
  });

  it("never applies the carry-over to home office or sick days", () => {
    expect(allowanceFor(row, CalendarRecordType.HomeOffice, policy())).toEqual({
      yearQuota: 5,
      carriedOverDays: 0,
    });
    expect(allowanceFor(row, CalendarRecordType.SickDay, policy())).toEqual({
      yearQuota: 2,
      carriedOverDays: 0,
    });
  });

  it("leaves sick days unmetered where the organization's benefit is off", () => {
    expect(
      allowanceFor(row, CalendarRecordType.SickDay, policy({ sickDayBenefitEnabled: false }))
    ).toBeNull();
    expect(allowanceFor(row, CalendarRecordType.SickDay, undefined)).toBeNull();
  });

  it("meters vacation and home office even without a live group", () => {
    expect(allowanceFor(row, CalendarRecordType.Vacation, undefined)).not.toBeNull();
    expect(allowanceFor(row, CalendarRecordType.HomeOffice, undefined)).not.toBeNull();
  });

  it("meters no type that does not draw down an allowance", () => {
    expect(allowanceFor(row, CalendarRecordType.Sick, policy())).toBeNull();
    expect(allowanceFor(row, CalendarRecordType.Other, policy())).toBeNull();
  });
});

describe("totalAllowance", () => {
  it("adds the carry-over to the year quota", () => {
    expect(totalAllowance({ yearQuota: 20, carriedOverDays: 4 })).toBe(24);
  });
});

describe("getMemberYearAllocations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves each group from its row, or from its defaults where the row is missing", async () => {
    mockGetUserYearQuotasForGroups.mockResolvedValue([{ ...row, userId: "u-1", groupId: "g-1" }]);
    mockGetGroupAllowancePolicies.mockResolvedValue(
      new Map([
        ["g-1", policy()],
        ["g-2", policy({ defaultVacationDays: 12, sickDayBenefitEnabled: false })],
      ])
    );

    const allocations = await getMemberYearAllocations("u-1", ["g-1", "g-2"], 2026);

    expect(mockGetUserYearQuotasForGroups).toHaveBeenCalledWith(
      "u-1",
      ["g-1", "g-2"],
      "2026",
      undefined
    );
    expect(allocations.get("g-1")?.allocation).toMatchObject({
      vacationDays: 20,
      carriedOverDays: 4,
    });
    expect(allocations.get("g-2")).toEqual({
      allocation: { vacationDays: 12, homeOfficeDays: 10, sickDays: 3, carriedOverDays: 0 },
      policy: policy({ defaultVacationDays: 12, sickDayBenefitEnabled: false }),
    });
  });

  it("skips the lookups for no groups", async () => {
    expect((await getMemberYearAllocations("u-1", [], 2026)).size).toBe(0);
    expect(mockGetUserYearQuotasForGroups).not.toHaveBeenCalled();
    expect(mockGetGroupAllowancePolicies).not.toHaveBeenCalled();
  });
});

describe("getMemberYearAllocation", () => {
  it("resolves a single group the same way", async () => {
    mockGetUserYearQuotasForGroups.mockResolvedValue([]);
    mockGetGroupAllowancePolicies.mockResolvedValue(new Map([["g-1", policy()]]));

    expect(await getMemberYearAllocation("u-1", "g-1", 2026)).toEqual({
      allocation: { vacationDays: 25, homeOfficeDays: 10, sickDays: 3, carriedOverDays: 0 },
      policy: policy(),
    });
  });
});
