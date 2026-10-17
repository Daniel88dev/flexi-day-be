import { afterEach, describe, expect, it, vi } from "vitest";
import { validatePutBirthday } from "../types.js";

describe("validatePutBirthday", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts 29 February, with or without a year", () => {
    expect(
      validatePutBirthday.safeParse({ month: 2, day: 29, year: null, shared: false }).success
    ).toBe(true);
    expect(
      validatePutBirthday.safeParse({ month: 2, day: 29, year: 1992, shared: true }).success
    ).toBe(true);
  });

  it("refuses a day the month never has", () => {
    expect(
      validatePutBirthday.safeParse({ month: 4, day: 31, year: null, shared: false }).success
    ).toBe(false);
    expect(
      validatePutBirthday.safeParse({ month: 2, day: 30, year: null, shared: false }).success
    ).toBe(false);
  });

  it("accepts the last day of every month", () => {
    const lastDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    lastDays.forEach((day, index) => {
      expect(
        validatePutBirthday.safeParse({ month: index + 1, day, year: null, shared: false }).success
      ).toBe(true);
    });
  });

  it("takes years from 1900 to the current year", () => {
    vi.useFakeTimers({ now: new Date("2026-10-17T12:00:00Z"), toFake: ["Date"] });
    const withYear = (year: number) =>
      validatePutBirthday.safeParse({ month: 1, day: 1, year, shared: false }).success;

    expect(withYear(1900)).toBe(true);
    expect(withYear(2026)).toBe(true);
    expect(withYear(1899)).toBe(false);
    expect(withYear(2027)).toBe(false);
  });

  it("treats a missing year as none", () => {
    expect(validatePutBirthday.parse({ month: 7, day: 4, shared: false })).toEqual({
      month: 7,
      day: 4,
      year: null,
      shared: false,
    });
  });

  it("refuses months and days out of range, fractions and a missing share flag", () => {
    const refused = [
      { month: 0, day: 1, shared: false },
      { month: 13, day: 1, shared: false },
      { month: 1, day: 0, shared: false },
      { month: 1.5, day: 1, shared: false },
      { month: 1, day: 1 },
      { month: "1", day: 1, shared: false },
    ];
    for (const body of refused) {
      expect(validatePutBirthday.safeParse(body).success).toBe(false);
    }
  });
});
