/**
 * Tests for utils/dateFunc.ts
 * Testing framework: Jest-style APIs (describe/test/it/expect). Compatible with Vitest.
 * Focus: formatDateToISOString and formatStartAndEndDate behaviors introduced/changed in PR diff.
 */

import { formatDateToISOString, formatStartAndEndDate } from "../../utils/dateFunc";

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

  test("invalid Date yields 'NaN-NaN-NaN' (current implementation behavior)", () => {
    const invalid = new Date(NaN);
    expect(formatDateToISOString(invalid)).toBe("NaN-NaN-NaN");
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

  test("throws for month < 1 with message and context", () => {
    expect.assertions(3);
    try {
      formatStartAndEndDate(2024, 0);
      // istanbul ignore next
      fail("Expected an error for month < 1 but none was thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/month must be between 1 and 12/);
      expect(err?.context).toEqual({ month: 0, year: 2024 });
    }
  });

  test("throws for month > 12 with message and context", () => {
    expect.assertions(3);
    try {
      formatStartAndEndDate(2024, 13);
      // istanbul ignore next
      fail("Expected an error for month > 12 but none was thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/month must be between 1 and 12/);
      expect(err?.context).toEqual({ month: 13, year: 2024 });
    }
  });

  test("fractional month is effectively truncated by Date.UTC (2.9 → Feb)", () => {
    const result = formatStartAndEndDate(2024, 2.9 as unknown as number);
    expect(result).toEqual({
      startDate: "2024-02-01",
      endDate: "2024-03-01",
    });
  });
});