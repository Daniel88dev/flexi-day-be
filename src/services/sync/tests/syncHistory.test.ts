import { describe, it, expect } from "vitest";
import { sameHistoryWindow, syncBankHolidayWindow, syncHistoryWindow } from "../syncHistory.js";

describe("syncHistoryWindow", () => {
  it("starts on 1 January of the previous year", () => {
    expect(syncHistoryWindow(new Date("2026-09-19T10:00:00.000Z"))).toEqual({
      firstDay: "2025-01-01",
      firstYear: "2025",
    });
  });

  it("keeps the previous year on 1 January itself", () => {
    expect(syncHistoryWindow(new Date("2026-01-01T00:00:00.000Z")).firstDay).toBe("2025-01-01");
  });

  it("moves with the server clock across a new year", () => {
    expect(syncHistoryWindow(new Date("2027-12-31T23:59:59.000Z"))).toEqual({
      firstDay: "2026-01-01",
      firstYear: "2026",
    });
  });
});

describe("sameHistoryWindow", () => {
  it("holds within one calendar year", () => {
    expect(
      sameHistoryWindow(new Date("2026-01-01T00:00:00.000Z"), new Date("2026-12-31T23:59:59.999Z"))
    ).toBe(true);
  });

  it("breaks across New Year, whichever side is earlier", () => {
    const lastYear = new Date("2026-12-31T23:59:59.999Z");
    const thisYear = new Date("2027-01-01T00:00:00.000Z");
    expect(sameHistoryWindow(lastYear, thisYear)).toBe(false);
    expect(sameHistoryWindow(thisYear, lastYear)).toBe(false);
  });
});

describe("syncBankHolidayWindow", () => {
  it("spans the previous, current and next year of the cursor time", () => {
    expect(syncBankHolidayWindow(new Date("2026-09-19T10:00:00.000Z"))).toEqual({
      years: [2025, 2026, 2027],
      firstDay: "2025-01-01",
      lastDay: "2027-12-31",
    });
  });

  it("reads the year in UTC, not the server's zone", () => {
    expect(syncBankHolidayWindow(new Date("2026-12-31T23:30:00.000Z")).years).toEqual([
      2025, 2026, 2027,
    ]);
    expect(syncBankHolidayWindow(new Date("2027-01-01T00:30:00.000Z")).years).toEqual([
      2026, 2027, 2028,
    ]);
  });
});
