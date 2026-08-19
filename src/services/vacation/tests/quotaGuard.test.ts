import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSumCountedDaysForQuota, mockGetUserYearGroupQuotas, mockGetGroup } = vi.hoisted(() => ({
  mockSumCountedDaysForQuota: vi.fn(),
  mockGetUserYearGroupQuotas: vi.fn(),
  mockGetGroup: vi.fn(),
}));

vi.mock("../../DBServices.js", () => ({
  createDBServices: () => ({
    vacation: { sumCountedDaysForQuota: mockSumCountedDaysForQuota },
    userYearQuotas: { getUserYearGroupQuotas: mockGetUserYearGroupQuotas },
    group: { getGroup: mockGetGroup },
  }),
}));

import { assertEditWithinQuota, assertRequestWithinQuota } from "../quotaGuard.js";
import { vacationType } from "../../../db/schema/vacation-schema.js";
import type { DbTransaction } from "../../../db/db.js";

const tx = { execute: vi.fn() } as unknown as DbTransaction;

const editedRow = (overrides: Record<string, unknown> = {}) => ({
  id: "v-1",
  userId: "u-1",
  groupId: "g-1",
  requestedDay: "2026-08-20",
  vacationType: vacationType.Vacation,
  halfDay: false,
  ...overrides,
});

describe("assertEditWithinQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserYearGroupQuotas.mockResolvedValue([
      { vacationDays: 1, carriedOverDays: 0, homeOfficeDays: 0 },
    ]);
  });

  it("excludes the edited rows so their pre-edit weight is not double-counted", async () => {
    // Allowance of exactly 1: the member's only booking is the row being
    // edited. Without the exclusion the old full-day weight would still count
    // and the same-weight edit would spuriously exceed the allowance.
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 0 });

    await expect(
      assertEditWithinQuota([editedRow({ halfDay: true })], tx)
    ).resolves.toBeUndefined();

    expect(mockSumCountedDaysForQuota).toHaveBeenCalledWith(
      "u-1",
      "g-1",
      2026,
      vacationType.Vacation,
      ["v-1"],
      tx
    );
  });

  it("rejects an edit whose post-edit weight exceeds the allowance", async () => {
    // Other live bookings already hold the whole allowance.
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0.5, pending: 0.5 });

    await expect(assertEditWithinQuota([editedRow()], tx)).rejects.toThrow(
      "This would exceed the allowance for that leave type"
    );
  });

  it("counts pending days, exactly as the create-time guard does", async () => {
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 1 });

    await expect(assertEditWithinQuota([editedRow({ halfDay: true })], tx)).rejects.toThrow(
      "This would exceed the allowance for that leave type"
    );
  });

  it("ignores non-quota-bearing types", async () => {
    await expect(
      assertEditWithinQuota([editedRow({ vacationType: vacationType.Sick })], tx)
    ).resolves.toBeUndefined();
    expect(mockSumCountedDaysForQuota).not.toHaveBeenCalled();
  });
});

describe("assertRequestWithinQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserYearGroupQuotas.mockResolvedValue([
      { vacationDays: 1, carriedOverDays: 0, homeOfficeDays: 0 },
    ]);
  });

  it("excludes nothing — new rows are not stored yet", async () => {
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 0 });

    await assertRequestWithinQuota([editedRow()], tx);

    expect(mockSumCountedDaysForQuota).toHaveBeenCalledWith(
      "u-1",
      "g-1",
      2026,
      vacationType.Vacation,
      [],
      tx
    );
  });
});
