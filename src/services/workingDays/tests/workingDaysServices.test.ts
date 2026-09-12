import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnsureBankHolidays } = vi.hoisted(() => ({ mockEnsureBankHolidays: vi.fn() }));

vi.mock("../../bankHoliday/bankHolidayServices.js", () => ({
  ensureBankHolidays: mockEnsureBankHolidays,
}));

const { getNonWorkingDays } = await import("../workingDaysServices.js");
const { NonWorkingDayCause } = await import("../types.js");

const holiday = (date: string, name: string) => ({
  id: date,
  date,
  name,
  country: "CZ",
  region: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const WEEKDAYS = [1, 2, 3, 4, 5];

describe("getNonWorkingDays", () => {
  beforeEach(() => {
    mockEnsureBankHolidays.mockReset();
    mockEnsureBankHolidays.mockResolvedValue([]);
  });

  it("names the days of the week the organization does not work", async () => {
    const days = await getNonWorkingDays(
      { workingDays: WEEKDAYS, holidayCountry: null },
      "2026-09-04",
      "2026-09-07"
    );

    expect([...days.keys()]).toEqual(["2026-09-05", "2026-09-06"]);
    expect(days.get("2026-09-05")).toEqual({
      cause: NonWorkingDayCause.NonWorkingDay,
      name: null,
    });
  });

  it("adds the public holidays of the organization's country, with their names", async () => {
    mockEnsureBankHolidays.mockResolvedValue([holiday("2026-09-28", "Den české státnosti")]);

    const days = await getNonWorkingDays(
      { workingDays: WEEKDAYS, holidayCountry: "CZ" },
      "2026-09-28",
      "2026-09-30"
    );

    expect(mockEnsureBankHolidays).toHaveBeenCalledWith(2026, "CZ", undefined, undefined);
    expect(days.get("2026-09-28")).toEqual({
      cause: NonWorkingDayCause.Holiday,
      name: "Den české státnosti",
    });
  });

  it("treats no day as a holiday for an organization that names no country", async () => {
    const days = await getNonWorkingDays(
      { workingDays: WEEKDAYS, holidayCountry: null },
      "2026-09-28",
      "2026-09-28"
    );

    expect(mockEnsureBankHolidays).not.toHaveBeenCalled();
    expect(days.size).toBe(0);
  });

  it("leaves a holiday that falls on a day nobody works reading as the day off it is", async () => {
    mockEnsureBankHolidays.mockResolvedValue([holiday("2026-09-06", "A Sunday holiday")]);

    const days = await getNonWorkingDays(
      { workingDays: WEEKDAYS, holidayCountry: "CZ" },
      "2026-09-05",
      "2026-09-06"
    );

    expect(days.get("2026-09-06")?.cause).toBe(NonWorkingDayCause.NonWorkingDay);
  });

  it("fills every year the range touches, not only the first", async () => {
    mockEnsureBankHolidays.mockImplementation(async (year: number) =>
      year === 2026
        ? [holiday("2026-12-25", "1. svátek vánoční")]
        : [holiday("2027-01-01", "Nový rok")]
    );

    const days = await getNonWorkingDays(
      { workingDays: [0, 1, 2, 3, 4, 5, 6], holidayCountry: "CZ" },
      "2026-12-24",
      "2027-01-02"
    );

    expect(mockEnsureBankHolidays.mock.calls.map((call) => call[0])).toEqual([2026, 2027]);
    expect([...days.keys()]).toEqual(["2026-12-25", "2027-01-01"]);
  });

  it("answers with nothing when the range runs backwards", async () => {
    const days = await getNonWorkingDays(
      { workingDays: WEEKDAYS, holidayCountry: "CZ" },
      "2026-09-30",
      "2026-09-01"
    );

    expect(days.size).toBe(0);
  });
});
