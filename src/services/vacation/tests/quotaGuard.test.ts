import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSumCountedDaysForQuota, mockGetMemberYearAllocations } = vi.hoisted(() => ({
  mockSumCountedDaysForQuota: vi.fn(),
  mockGetMemberYearAllocations: vi.fn(),
}));

vi.mock("../../userYearQuotas/yearAllocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../userYearQuotas/yearAllocation.js")>()),
  getMemberYearAllocations: mockGetMemberYearAllocations,
}));

vi.mock("../vacationServices.js", () => ({
  sumCountedDaysForQuota: mockSumCountedDaysForQuota,
}));

import { assertEditWithinQuota, assertRequestWithinQuota } from "../quotaGuard.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import type { DbTransaction } from "../../../db/db.js";
import type { QuotaFigures } from "../../userYearQuotas/types.js";

const execute = vi.fn();
const tx = { execute } as unknown as DbTransaction;

/** Every group the guard asks about gets `figures`; only `sickDayGroups` meter sick days. */
const allocate = (figures: Partial<QuotaFigures>, sickDayGroups: string[] = []) =>
  mockGetMemberYearAllocations.mockImplementation((_userId: string, groupIds: string[]) =>
    Promise.resolve(
      new Map(
        groupIds.map((groupId) => [
          groupId,
          {
            allocation: {
              vacationDays: 0,
              homeOfficeDays: 0,
              sickDays: 0,
              carriedOverDays: 0,
              ...figures,
            },
            policy: {
              defaultVacationDays: 20,
              defaultHomeOfficeDays: 0,
              defaultSickDays: 0,
              sickDayBenefitEnabled: sickDayGroups.includes(groupId),
            },
          },
        ])
      )
    )
  );

const editedRow = (overrides: Record<string, unknown> = {}) => ({
  id: "v-1",
  userId: "u-1",
  groupId: "g-1",
  requestedDay: "2026-08-20",
  vacationType: CalendarRecordType.Vacation,
  halfDay: false,
  ...overrides,
});

describe("assertEditWithinQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allocate({ vacationDays: 1 });
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
      CalendarRecordType.Vacation,
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
      assertEditWithinQuota([editedRow({ vacationType: CalendarRecordType.Sick })], tx)
    ).resolves.toBeUndefined();
    expect(mockSumCountedDaysForQuota).not.toHaveBeenCalled();
  });
});

describe("assertRequestWithinQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allocate({ vacationDays: 1 });
  });

  it("excludes nothing — new rows are not stored yet", async () => {
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 0 });

    await assertRequestWithinQuota([editedRow()], tx);

    expect(mockSumCountedDaysForQuota).toHaveBeenCalledWith(
      "u-1",
      "g-1",
      2026,
      CalendarRecordType.Vacation,
      [],
      tx
    );
  });

  it("bounds a member with no quota row by the group default it resolves to", async () => {
    // What `resolveYearAllocation` gives a missing row: the default, nothing carried over.
    allocate({ vacationDays: 2, carriedOverDays: 0 });
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 1, pending: 0 });

    await expect(assertRequestWithinQuota([editedRow()], tx)).resolves.toBeUndefined();

    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 1, pending: 1 });
    await expect(assertRequestWithinQuota([editedRow()], tx)).rejects.toMatchObject({
      errors: [{ publicContext: { allocated: 2, exceededBy: 1 } }],
    });
  });

  it("reads the allocation only after taking the allowance lock", async () => {
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 0 });

    await assertRequestWithinQuota([editedRow()], tx);

    const [lockedAt] = execute.mock.invocationCallOrder;
    const [readAt] = mockGetMemberYearAllocations.mock.invocationCallOrder;
    expect(lockedAt).toBeDefined();
    expect(readAt).toBeGreaterThan(lockedAt ?? Infinity);
  });

  it("reads each member's allocation once per year, across the decision's groups and types", async () => {
    allocate({ vacationDays: 5, homeOfficeDays: 5 });
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 0 });

    await assertRequestWithinQuota(
      [
        editedRow({ id: "v-a" }),
        editedRow({ id: "v-b", vacationType: CalendarRecordType.HomeOffice }),
        editedRow({ id: "v-c", groupId: "g-2" }),
      ],
      tx
    );

    expect(mockGetMemberYearAllocations).toHaveBeenCalledTimes(1);
    expect(mockGetMemberYearAllocations).toHaveBeenCalledWith("u-1", ["g-1", "g-2"], 2026, tx);
    expect(mockSumCountedDaysForQuota).toHaveBeenCalledTimes(3);
  });
});

describe("sick day allowance", () => {
  const sickDayRow = (day: string, halfDay = false) =>
    editedRow({
      id: `v-${day}`,
      requestedDay: day,
      vacationType: CalendarRecordType.SickDay,
      halfDay,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSumCountedDaysForQuota.mockResolvedValue({ approved: 0, pending: 0 });
  });

  it("draws against the sick day column, without the vacation carry-over", async () => {
    // Generous vacation numbers prove the guard reads `sickDays` alone: with
    // carry-over included the second row would fit.
    allocate({ vacationDays: 20, carriedOverDays: 10, sickDays: 1 }, ["g-1"]);

    await expect(assertRequestWithinQuota([sickDayRow("2026-08-20")], tx)).resolves.toBeUndefined();
    await expect(
      assertRequestWithinQuota([sickDayRow("2026-08-20"), sickDayRow("2026-08-21")], tx)
    ).rejects.toThrow("This would exceed the allowance for that leave type");
  });

  it("weights a half day at 0.5, like every metered type", async () => {
    allocate({ sickDays: 1 }, ["g-1"]);

    await expect(
      assertRequestWithinQuota([sickDayRow("2026-08-20", true), sickDayRow("2026-08-21", true)], tx)
    ).resolves.toBeUndefined();
  });

  it("does not meter sick days for a group whose organization has the benefit off", async () => {
    // Legacy SICK_DAY rows predate the benefit: their organization never
    // switched it on, the allowance columns read 0, and approving or editing
    // them must keep working exactly as when the type was unmetered.
    allocate({});

    await expect(
      assertEditWithinQuota([sickDayRow("2026-08-20"), sickDayRow("2026-08-21")], tx)
    ).resolves.toBeUndefined();
    expect(mockSumCountedDaysForQuota).not.toHaveBeenCalled();
  });

  it("skips only the unmetered sick day bucket, not the other buckets of a bulk decision", async () => {
    // One decision spanning two groups: the sick day in the never-enabled
    // group sails through, while the vacation bucket must still be metered
    // and refuse. Buckets run in key order, so the sick day (g-1) goes first.
    allocate({});

    await expect(
      assertRequestWithinQuota(
        [
          editedRow({ id: "v-a", groupId: "g-2" }),
          editedRow({
            id: "v-b",
            groupId: "g-1",
            requestedDay: "2026-08-21",
            vacationType: CalendarRecordType.SickDay,
          }),
        ],
        tx
      )
    ).rejects.toThrow("This would exceed the allowance for that leave type");

    expect(mockSumCountedDaysForQuota).toHaveBeenCalledTimes(1);
    expect(mockSumCountedDaysForQuota).toHaveBeenCalledWith(
      "u-1",
      "g-2",
      2026,
      CalendarRecordType.Vacation,
      [],
      tx
    );
  });
});
