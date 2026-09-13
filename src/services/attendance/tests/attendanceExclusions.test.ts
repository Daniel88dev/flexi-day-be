import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockNonWorkingDays, mockGroupIds, mockAbsencesForUsers } = vi.hoisted(() => ({
  mockNonWorkingDays: vi.fn(),
  mockGroupIds: vi.fn(),
  mockAbsencesForUsers: vi.fn(),
}));

vi.mock("../../workingDays/workingDaysServices.js", () => ({
  getNonWorkingDays: mockNonWorkingDays,
}));

vi.mock("../../group/groupServices.js", () => ({
  getLiveGroupIdsForOrganizationOrdered: mockGroupIds,
}));

vi.mock("../../vacation/vacationServices.js", () => ({
  listExcusingAbsencesForUsers: mockAbsencesForUsers,
}));

const { getAttendanceExclusions, getAttendanceExclusionsForPeople } =
  await import("../attendanceExclusions.js");
const { AttendanceExclusionCause, AttendanceExclusionExtent } =
  await import("../attendanceCalculation.js");
const { NonWorkingDayCause } = await import("../../workingDays/types.js");
const { CalendarRecordType } = await import("../../../db/schema/vacation-schema.js");

const PRAGUE = "Europe/Prague";

const ask = (overrides: Partial<Parameters<typeof getAttendanceExclusions>[0]> = {}) =>
  getAttendanceExclusions({
    organizationId: "org-1",
    userId: "user-1",
    employment: { startedAt: new Date("2020-01-01T00:00:00Z"), endedAt: null },
    dates: ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"],
    rules: { workingDays: [1, 2, 3, 4, 5], holidayCountry: "CZ" },
    timezone: PRAGUE,
    ...overrides,
  });

describe("getAttendanceExclusions", () => {
  beforeEach(() => {
    mockNonWorkingDays.mockReset().mockResolvedValue(new Map());
    mockGroupIds.mockReset().mockResolvedValue(["group-1"]);
    mockAbsencesForUsers.mockReset().mockResolvedValue([]);
  });

  it("carries a non-working day and a holiday through with their causes", async () => {
    mockNonWorkingDays.mockResolvedValue(
      new Map([
        ["2026-09-05", { cause: NonWorkingDayCause.NonWorkingDay, name: null }],
        ["2026-09-07", { cause: NonWorkingDayCause.Holiday, name: "Den české státnosti" }],
      ])
    );

    const exclusions = await ask();

    expect(exclusions.get("2026-09-05")).toEqual({
      cause: AttendanceExclusionCause.NonWorkingDay,
      extent: AttendanceExclusionExtent.Full,
      label: null,
    });
    expect(exclusions.get("2026-09-07")).toEqual({
      cause: AttendanceExclusionCause.Holiday,
      extent: AttendanceExclusionExtent.Full,
      label: "Den české státnosti",
    });
  });

  it("excuses a day covered by an approved absence and names its type", async () => {
    mockAbsencesForUsers.mockResolvedValue([
      {
        userId: "user-1",
        requestedDay: "2026-09-04",
        vacationType: CalendarRecordType.SickDay,
        halfDay: false,
      },
    ]);

    expect(await ask().then((map) => map.get("2026-09-04"))).toEqual({
      cause: AttendanceExclusionCause.Absence,
      extent: AttendanceExclusionExtent.Full,
      label: "SICK_DAY",
    });
  });

  it("halves a day a half-day absence covers", async () => {
    mockAbsencesForUsers.mockResolvedValue([
      {
        userId: "user-1",
        requestedDay: "2026-09-04",
        vacationType: CalendarRecordType.Vacation,
        halfDay: true,
      },
    ]);

    expect(await ask().then((map) => map.get("2026-09-04"))).toMatchObject({
      extent: AttendanceExclusionExtent.Half,
      label: "VACATION",
    });
  });

  it("leaves a half day falling on a day nobody works fully excluded", async () => {
    mockNonWorkingDays.mockResolvedValue(
      new Map([["2026-09-05", { cause: NonWorkingDayCause.NonWorkingDay, name: null }]])
    );
    mockAbsencesForUsers.mockResolvedValue([
      {
        userId: "user-1",
        requestedDay: "2026-09-05",
        vacationType: CalendarRecordType.Vacation,
        halfDay: true,
      },
    ]);

    expect(await ask().then((map) => map.get("2026-09-05"))).toMatchObject({
      cause: AttendanceExclusionCause.NonWorkingDay,
      extent: AttendanceExclusionExtent.Full,
    });
  });

  it("asks only about the range, across every live group of the organization", async () => {
    await ask();

    expect(mockNonWorkingDays).toHaveBeenCalledWith(
      { workingDays: [1, 2, 3, 4, 5], holidayCountry: "CZ" },
      "2026-09-04",
      "2026-09-07",
      undefined
    );
    expect(mockGroupIds).toHaveBeenCalledWith("org-1", undefined);
    expect(mockAbsencesForUsers).toHaveBeenCalledWith(
      ["user-1"],
      ["group-1"],
      "2026-09-04",
      "2026-09-07",
      undefined
    );
  });

  it("excludes the days before the Employment began, in the organization's zone", async () => {
    const exclusions = await ask({
      // 01:30 in Prague on the 6th, not the 5th.
      employment: { startedAt: new Date("2026-09-05T23:30:00Z"), endedAt: null },
    });

    expect([...exclusions.keys()]).toEqual(["2026-09-04", "2026-09-05"]);
    expect(exclusions.get("2026-09-04")).toEqual({
      cause: AttendanceExclusionCause.NotEmployed,
      extent: AttendanceExclusionExtent.Full,
      label: null,
    });
  });

  it("excludes the days after it ended, and keeps the last day worked", async () => {
    const exclusions = await ask({
      employment: {
        startedAt: new Date("2020-01-01T00:00:00Z"),
        endedAt: new Date("2026-09-05T14:00:00Z"),
      },
    });

    expect([...exclusions.keys()]).toEqual(["2026-09-06", "2026-09-07"]);
  });

  it("lets the spell outrank a day off, because nothing was owed either way", async () => {
    mockNonWorkingDays.mockResolvedValue(
      new Map([["2026-09-05", { cause: NonWorkingDayCause.NonWorkingDay, name: null }]])
    );

    const exclusions = await ask({
      employment: { startedAt: new Date("2026-09-07T06:00:00Z"), endedAt: null },
    });

    expect(exclusions.get("2026-09-05")?.cause).toBe(AttendanceExclusionCause.NotEmployed);
  });

  it("does not ask about absences for somebody in no group", async () => {
    mockGroupIds.mockResolvedValue([]);

    await ask();

    expect(mockAbsencesForUsers).not.toHaveBeenCalled();
  });

  it("answers with nothing when the range is empty", async () => {
    const exclusions = await ask({ dates: [] });

    expect(exclusions.size).toBe(0);
    expect(mockNonWorkingDays).not.toHaveBeenCalled();
  });
});

describe("getAttendanceExclusionsForPeople", () => {
  const employedSince2020 = { startedAt: new Date("2020-01-01T00:00:00Z"), endedAt: null };

  const askForPeople = (
    people: { userId: string; employment: { startedAt: Date; endedAt: Date | null } }[]
  ) =>
    getAttendanceExclusionsForPeople({
      organizationId: "org-1",
      people,
      dates: ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"],
      rules: { workingDays: [1, 2, 3, 4, 5], holidayCountry: "CZ" },
      timezone: PRAGUE,
    });

  beforeEach(() => {
    mockNonWorkingDays.mockReset().mockResolvedValue(new Map());
    mockGroupIds.mockReset().mockResolvedValue(["group-1"]);
    mockAbsencesForUsers.mockReset().mockResolvedValue([]);
  });

  it("reads the calendar and the absences once for everybody", async () => {
    mockNonWorkingDays.mockResolvedValue(
      new Map([["2026-09-05", { cause: NonWorkingDayCause.NonWorkingDay, name: null }]])
    );
    mockAbsencesForUsers.mockResolvedValue([
      {
        userId: "user-2",
        requestedDay: "2026-09-04",
        vacationType: CalendarRecordType.Vacation,
        halfDay: false,
      },
    ]);

    const byUser = await askForPeople([
      { userId: "user-1", employment: employedSince2020 },
      { userId: "user-2", employment: employedSince2020 },
    ]);

    expect(mockNonWorkingDays).toHaveBeenCalledTimes(1);
    expect(mockAbsencesForUsers).toHaveBeenCalledWith(
      ["user-1", "user-2"],
      ["group-1"],
      "2026-09-04",
      "2026-09-07",
      undefined
    );

    expect(byUser.get("user-1")?.get("2026-09-04")).toBeUndefined();
    expect(byUser.get("user-1")?.get("2026-09-05")).toMatchObject({
      cause: AttendanceExclusionCause.NonWorkingDay,
    });
    expect(byUser.get("user-2")?.get("2026-09-04")).toEqual({
      cause: AttendanceExclusionCause.Absence,
      extent: AttendanceExclusionExtent.Full,
      label: "VACATION",
    });
  });

  it("keeps each person's own spell", async () => {
    const byUser = await askForPeople([
      { userId: "user-1", employment: employedSince2020 },
      {
        userId: "user-2",
        employment: { startedAt: new Date("2026-09-05T23:30:00Z"), endedAt: null },
      },
    ]);

    expect([...byUser.get("user-1")!.keys()]).toEqual([]);
    expect([...byUser.get("user-2")!.keys()]).toEqual(["2026-09-04", "2026-09-05"]);
  });

  it("answers an empty map per person, and asks nothing, when there is nobody", async () => {
    expect(await askForPeople([])).toEqual(new Map());
    expect(mockNonWorkingDays).not.toHaveBeenCalled();
  });
});
