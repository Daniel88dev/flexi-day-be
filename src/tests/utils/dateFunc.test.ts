/**
 * Tests for utils/dateFunc.ts
 * Testing framework: Jest-style APIs (describe/test/it/expect). Compatible with Vitest.
 * Focus: formatDateToISOString and formatStartAndEndDate behaviors introduced/changed in PR diff.
 */

import {
  filterWorkingDays,
  formatDateToISOString,
  formatStartAndEndDate,
  isWorkingDay,
} from "../../utils/dateFunc";

describe("formatDateToISOString", () => {
  test("formats a UTC date to YYYY-MM-DD (e.g., 2024-01-01)", () => {
    const d = new Date(Date.UTC(2024, 0, 1));
    expect(formatDateToISOString(d)).toBe("2024-01-01");
  });

  test("pads month and day with leading zeros (2024-09-05)", () => {
    const d = new Date(Date.UTC(2024, 8, 5)); // September (8), 5th
    expect(formatDateToISOString(d)).toBe("2024-09-05");
  });

  test("uses UTC components regardless of local timezone/DST", () => {
    // 2024-03-31 23:30:00 at UTC-05:00 is 2024-04-01 in UTC
    const d = new Date("2024-03-31T23:30:00-05:00");
    expect(formatDateToISOString(d)).toBe("2024-04-01");
  });

  test("handles leap day correctly (2020-02-29)", () => {
    const d = new Date(Date.UTC(2020, 1, 29));
    expect(formatDateToISOString(d)).toBe("2020-02-29");
  });
});

describe("formatStartAndEndDate", () => {
  test("returns start and end for a typical month (2024-09 → 2024-09-01..2024-10-01)", () => {
    expect(formatStartAndEndDate(2024, 9)).toEqual({
      startDate: "2024-09-01",
      endDate: "2024-10-01",
    });
  });

  test("December rollover to next year (2021-12 → 2021-12-01..2022-01-01)", () => {
    expect(formatStartAndEndDate(2021, 12)).toEqual({
      startDate: "2021-12-01",
      endDate: "2022-01-01",
    });
  });

  test("February in a leap year (2020-02 → 2020-02-01..2020-03-01)", () => {
    expect(formatStartAndEndDate(2020, 2)).toEqual({
      startDate: "2020-02-01",
      endDate: "2020-03-01",
    });
  });

  test("fractional month is effectively truncated by Date.UTC (2.9 → Feb)", () => {
    const result = formatStartAndEndDate(2024, 2.9 as unknown as number);
    expect(result).toEqual({
      startDate: "2024-02-01",
      endDate: "2024-03-01",
    });
  });
});

describe("isWorkingDay", () => {
  const monToFri = [1, 2, 3, 4, 5];

  test("returns true for a weekday when Mon-Fri are working days", () => {
    // 2024-07-24 is a Wednesday.
    expect(isWorkingDay("2024-07-24", monToFri)).toBe(true);
  });

  test("returns false for a Saturday when Mon-Fri are working days", () => {
    // 2024-07-27 is a Saturday.
    expect(isWorkingDay("2024-07-27", monToFri)).toBe(false);
  });

  test("respects a custom working-day set including weekends", () => {
    // Sunday (0) and Saturday (6) only.
    expect(isWorkingDay("2024-07-28", [0, 6])).toBe(true); // Sunday
    expect(isWorkingDay("2024-07-24", [0, 6])).toBe(false); // Wednesday
  });

  test("returns false for an invalid date string", () => {
    expect(isWorkingDay("not-a-date", monToFri)).toBe(false);
  });
});

describe("filterWorkingDays", () => {
  const monToFri = [1, 2, 3, 4, 5];

  test("keeps only working days and preserves order", () => {
    // Fri 2024-07-26 .. Mon 2024-07-29 → drops Sat/Sun.
    const days = ["2024-07-26", "2024-07-27", "2024-07-28", "2024-07-29"];
    expect(filterWorkingDays(days, monToFri)).toEqual(["2024-07-26", "2024-07-29"]);
  });

  test("returns an empty array when no day is a working day", () => {
    expect(filterWorkingDays(["2024-07-27", "2024-07-28"], monToFri)).toEqual([]);
  });

  test("returns all days when every day is a working day", () => {
    const days = ["2024-07-24", "2024-07-25"];
    expect(filterWorkingDays(days, monToFri)).toEqual(days);
  });
});
