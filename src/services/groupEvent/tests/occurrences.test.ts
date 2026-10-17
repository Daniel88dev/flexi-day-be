import { describe, expect, it } from "vitest";
import {
  birthdayOccurrences,
  occurrences,
  type OccurrenceSource,
  type RepeatRule,
} from "../occurrences.js";

const rule = (patch: Partial<RepeatRule> & Pick<RepeatRule, "freq">): RepeatRule => ({
  interval: 1,
  weekdays: [],
  monthlyMode: null,
  until: null,
  ...patch,
});

const recurring = (
  startDate: string,
  repeat: RepeatRule,
  skippedDates: string[] = []
): OccurrenceSource => ({ startDate, endDate: startDate, repeat, skippedDates });

const dates = (source: OccurrenceSource, from: string, to: string) =>
  occurrences(source, from, to).map((occurrence) => occurrence.startDate);

// Spec section 6.4: the table every copy of `occurrences` (backend, web, phone) passes.
describe("occurrences, shared vectors", () => {
  it("weekly ×1 Mon,Wed from Mon 5 Oct 2026", () => {
    const source = recurring("2026-10-05", rule({ freq: "weekly", weekdays: [0, 2] }));
    expect(dates(source, "2026-10-05", "2026-10-18")).toEqual([
      "2026-10-05",
      "2026-10-07",
      "2026-10-12",
      "2026-10-14",
    ]);
  });

  it("weekly ×2 Tue from 6 Oct, until 3 Nov", () => {
    const source = recurring(
      "2026-10-06",
      rule({ freq: "weekly", interval: 2, weekdays: [1], until: "2026-11-03" })
    );
    expect(dates(source, "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-06",
      "2026-10-20",
      "2026-11-03",
    ]);
  });

  it("monthly day 31 from 31 Jan 2027", () => {
    const source = recurring("2027-01-31", rule({ freq: "monthly", monthlyMode: "day" }));
    expect(dates(source, "2027-01-01", "2027-05-31")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
  });

  it("monthly day 30 from 30 Jan 2028", () => {
    const source = recurring("2028-01-30", rule({ freq: "monthly", monthlyMode: "day" }));
    expect(dates(source, "2028-01-01", "2028-03-31")).toEqual([
      "2028-01-30",
      "2028-02-29",
      "2028-03-30",
    ]);
  });

  it("monthly last Fri from 30 Oct 2026", () => {
    const source = recurring("2026-10-30", rule({ freq: "monthly", monthlyMode: "lastWeekday" }));
    expect(dates(source, "2026-10-01", "2026-12-31")).toEqual([
      "2026-10-30",
      "2026-11-27",
      "2026-12-25",
    ]);
  });

  it("monthly 2nd Tue from 13 Oct 2026, skip 10 Nov", () => {
    const source = recurring("2026-10-13", rule({ freq: "monthly", monthlyMode: "weekday" }), [
      "2026-11-10",
    ]);
    expect(dates(source, "2026-10-01", "2026-12-31")).toEqual(["2026-10-13", "2026-12-08"]);
  });

  it("yearly from 29 Feb 2028", () => {
    const source = recurring("2028-02-29", rule({ freq: "yearly" }));
    expect(dates(source, "2028-01-01", "2030-12-31")).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
    ]);
  });

  it("daily ×3 from 1 Oct, until 10 Oct", () => {
    const source = recurring(
      "2026-10-01",
      rule({ freq: "daily", interval: 3, until: "2026-10-10" })
    );
    expect(dates(source, "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-01",
      "2026-10-04",
      "2026-10-07",
      "2026-10-10",
    ]);
  });

  it("birthday 29 Feb, year 1990", () => {
    expect(
      birthdayOccurrences({ month: 2, day: 29, year: 1990 }, "2027-01-01", "2027-12-31")
    ).toEqual([{ date: "2027-02-28", age: 37 }]);
  });
});

describe("occurrences, one-off group events", () => {
  const oneOff: OccurrenceSource = {
    startDate: "2026-10-21",
    endDate: "2026-10-23",
    repeat: null,
    skippedDates: [],
  };

  it("answers the whole span when any of its days falls in the window", () => {
    expect(occurrences(oneOff, "2026-10-23", "2026-10-31")).toEqual([
      { startDate: "2026-10-21", endDate: "2026-10-23" },
    ]);
  });

  it("answers nothing for a window that misses it", () => {
    expect(occurrences(oneOff, "2026-10-24", "2026-10-31")).toEqual([]);
    expect(occurrences(oneOff, "2026-10-01", "2026-10-20")).toEqual([]);
  });
});

describe("occurrences, windows far from the start", () => {
  it("lands on the right days years after a daily start", () => {
    const source = recurring("2026-01-01", rule({ freq: "daily", interval: 7 }));
    expect(dates(source, "2030-01-01", "2030-01-14")).toEqual(["2030-01-03", "2030-01-10"]);
  });

  it("keeps the week parity of a fortnightly rule", () => {
    const source = recurring("2026-10-06", rule({ freq: "weekly", interval: 2, weekdays: [1, 3] }));
    expect(dates(source, "2027-01-01", "2027-01-17")).toEqual(["2027-01-12", "2027-01-14"]);
  });

  it("never answers a day before the start", () => {
    const source = recurring("2026-10-07", rule({ freq: "weekly", weekdays: [0, 2] }));
    expect(dates(source, "2026-10-01", "2026-10-13")).toEqual(["2026-10-07", "2026-10-12"]);
  });
});
