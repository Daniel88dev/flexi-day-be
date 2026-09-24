import { describe, it, expect } from "vitest";
import { entryRefusal } from "../attendanceEntries.js";

const PRAGUE = "Europe/Prague";

const at = (iso: string) => new Date(iso);

describe("entryRefusal", () => {
  // Friday 11 September 2026, 12:00 in Prague.
  const now = at("2026-09-11T10:00:00Z");

  const ask = (
    entry: { businessDate: string; startedAt: string; endedAt: string },
    options: {
      ceilingMinutes?: number;
      spell?: { startedAt: Date; endedAt: Date | null };
      timezone?: string;
    } = {}
  ) =>
    entryRefusal({
      businessDate: entry.businessDate,
      startedAt: at(entry.startedAt),
      endedAt: at(entry.endedAt),
      timezone: options.timezone ?? PRAGUE,
      now,
      ceilingMinutes: options.ceilingMinutes ?? 960,
      spell: options.spell ?? { startedAt: at("2020-01-01T00:00:00Z"), endedAt: null },
    });

  it("accepts an ordinary day in the past", () => {
    expect(
      ask({
        businessDate: "2026-09-08",
        startedAt: "2026-09-08T06:10:00Z",
        endedAt: "2026-09-08T14:55:00Z",
      })
    ).toBeNull();
  });

  describe("the business date", () => {
    it("refuses a start that falls on another date in the organization's zone", () => {
      expect(
        ask({
          businessDate: "2026-09-08",
          startedAt: "2026-09-09T06:00:00Z",
          endedAt: "2026-09-09T10:00:00Z",
        })
      ).toBe("START_OFF_DATE");
    });

    it("reads the start's date in the organization's zone, not UTC", () => {
      // 22:30 UTC on the 7th is 00:30 on the 8th in Prague.
      const entry = {
        businessDate: "2026-09-08",
        startedAt: "2026-09-07T22:30:00Z",
        endedAt: "2026-09-08T04:00:00Z",
      };

      expect(ask(entry)).toBeNull();
      expect(ask(entry, { timezone: "UTC" })).toBe("START_OFF_DATE");
    });

    it("lets the end cross midnight, keeping the day it started", () => {
      // 22:00 Tuesday to 06:15 Wednesday, Prague.
      expect(
        ask({
          businessDate: "2026-09-08",
          startedAt: "2026-09-08T20:00:00Z",
          endedAt: "2026-09-09T04:15:00Z",
        })
      ).toBeNull();
    });
  });

  describe("the times", () => {
    it("refuses an end at or before the start", () => {
      expect(
        ask({
          businessDate: "2026-09-08",
          startedAt: "2026-09-08T14:55:00Z",
          endedAt: "2026-09-08T06:10:00Z",
        })
      ).toBe("END_BEFORE_START");
      expect(
        ask({
          businessDate: "2026-09-08",
          startedAt: "2026-09-08T06:10:00Z",
          endedAt: "2026-09-08T06:10:00Z",
        })
      ).toBe("END_BEFORE_START");
    });

    it("refuses an end later than now, and takes one exactly now", () => {
      expect(
        ask({
          businessDate: "2026-09-11",
          startedAt: "2026-09-11T06:00:00Z",
          endedAt: "2026-09-11T10:00:01Z",
        })
      ).toBe("END_IN_FUTURE");
      expect(
        ask({
          businessDate: "2026-09-11",
          startedAt: "2026-09-11T06:00:00Z",
          endedAt: "2026-09-11T10:00:00Z",
        })
      ).toBeNull();
    });

    it("refuses a span longer than the ceiling, and takes one exactly as long", () => {
      const eightHours = {
        businessDate: "2026-09-08",
        startedAt: "2026-09-08T06:00:00Z",
        endedAt: "2026-09-08T14:00:00Z",
      };

      expect(ask(eightHours, { ceilingMinutes: 479 })).toBe("OVER_CEILING");
      expect(ask(eightHours, { ceilingMinutes: 480 })).toBeNull();
    });
  });

  describe("the Employment's spell", () => {
    const entry = {
      businessDate: "2026-09-08",
      startedAt: "2026-09-08T06:00:00Z",
      endedAt: "2026-09-08T14:00:00Z",
    };

    it("refuses a date before the spell began and takes its first day", () => {
      // Began 09:00 on the 8th in Prague: the 8th is its first day, the 7th is not.
      const spell = { startedAt: at("2026-09-08T07:00:00Z"), endedAt: null };

      expect(ask(entry, { spell })).toBeNull();
      expect(
        ask(
          {
            businessDate: "2026-09-07",
            startedAt: "2026-09-07T06:00:00Z",
            endedAt: "2026-09-07T14:00:00Z",
          },
          { spell }
        )
      ).toBe("OUTSIDE_EMPLOYMENT");
    });

    it("refuses a date after the spell ended and takes its last day", () => {
      const spell = {
        startedAt: at("2020-01-01T00:00:00Z"),
        endedAt: at("2026-09-07T15:00:00Z"),
      };

      expect(ask(entry, { spell })).toBe("OUTSIDE_EMPLOYMENT");
      expect(
        ask(
          {
            businessDate: "2026-09-07",
            startedAt: "2026-09-07T06:00:00Z",
            endedAt: "2026-09-07T14:00:00Z",
          },
          { spell }
        )
      ).toBeNull();
    });
  });
});
