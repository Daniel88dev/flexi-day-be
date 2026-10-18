import { describe, expect, it } from "vitest";
import { birthdayOccurrence } from "../birthdayOccurrence.js";

const window = (startDate: string, endDate: string) => ({ startDate, endDate });

describe("birthdayOccurrence", () => {
  it("lands 29 February 1990 on 28 February 2027, age 37", () => {
    expect(
      birthdayOccurrence({ month: 2, day: 29, year: 1990 }, window("2027-01-01", "2028-01-01"))
    ).toEqual({ date: "2027-02-28", age: 37 });
  });

  it("keeps 29 February in a leap year", () => {
    expect(
      birthdayOccurrence({ month: 2, day: 29, year: 1992 }, window("2028-01-26", "2028-03-07"))
    ).toEqual({ date: "2028-02-29", age: 36 });
  });

  it("answers no age without a year", () => {
    expect(
      birthdayOccurrence({ month: 10, day: 20, year: null }, window("2026-09-25", "2026-11-07"))
    ).toEqual({ date: "2026-10-20", age: null });
  });

  it("finds a birthday in the padding of the next year", () => {
    expect(
      birthdayOccurrence({ month: 1, day: 3, year: 2000 }, window("2026-11-25", "2027-01-07"))
    ).toEqual({ date: "2027-01-03", age: 27 });
  });

  it("finds a birthday in the padding of the previous year", () => {
    expect(
      birthdayOccurrence({ month: 12, day: 30, year: null }, window("2026-12-26", "2027-02-07"))
    ).toEqual({ date: "2026-12-30", age: null });
  });

  it("answers null outside the window, the end being exclusive", () => {
    expect(
      birthdayOccurrence({ month: 3, day: 7, year: null }, window("2028-01-26", "2028-03-07"))
    ).toBeNull();
    expect(
      birthdayOccurrence({ month: 1, day: 26, year: null }, window("2028-01-26", "2028-03-07"))
    ).toEqual({ date: "2028-01-26", age: null });
  });

  it("shows nothing before the person was born", () => {
    expect(
      birthdayOccurrence({ month: 5, day: 1, year: 2025 }, window("2024-04-25", "2024-06-07"))
    ).toBeNull();
    expect(
      birthdayOccurrence({ month: 5, day: 1, year: 2025 }, window("2025-04-25", "2025-06-07"))
    ).toEqual({ date: "2025-05-01", age: 0 });
  });
});
