import { describe, it, expect } from "vitest";
import { selfServiceRefusal } from "../selfServiceWindow.js";

const PRAGUE = "Europe/Prague";

const at = (iso: string) => new Date(iso);

describe("selfServiceRefusal", () => {
  // 08:00 UTC on Thursday 10 September: 10:00 in Prague, the same date in both.
  const now = at("2026-09-10T08:00:00Z");

  const closedOn = (businessDate: string) => ({
    endedAt: at(`${businessDate}T15:00:00Z`),
    businessDate,
  });

  const ask = (
    session: { endedAt: Date | null; businessDate: string },
    window: { enabled: boolean; days: number | null },
    options: { employmentEnded?: boolean; timezone?: string; now?: Date } = {}
  ) =>
    selfServiceRefusal({
      session,
      window,
      employmentEnded: options.employmentEnded ?? false,
      timezone: options.timezone ?? PRAGUE,
      now: options.now ?? now,
    });

  describe("off", () => {
    it("refuses even today's session", () => {
      expect(ask(closedOn("2026-09-10"), { enabled: false, days: 0 })).toBe("SELF_SERVICE_OFF");
    });

    it("refuses a session that is still open", () => {
      expect(
        ask({ endedAt: null, businessDate: "2026-09-10" }, { enabled: false, days: null })
      ).toBe("SELF_SERVICE_OFF");
    });
  });

  describe("on with a number of days", () => {
    it("with 0 allows today and refuses yesterday", () => {
      expect(ask(closedOn("2026-09-10"), { enabled: true, days: 0 })).toBeNull();
      expect(ask(closedOn("2026-09-09"), { enabled: true, days: 0 })).toBe("SELF_SERVICE_WINDOW");
    });

    it("with 7 allows seven days back and refuses eight", () => {
      expect(ask(closedOn("2026-09-03"), { enabled: true, days: 7 })).toBeNull();
      expect(ask(closedOn("2026-09-02"), { enabled: true, days: 7 })).toBe("SELF_SERVICE_WINDOW");
    });

    it("counts calendar days across a month boundary", () => {
      // 31 August is ten days before 10 September.
      expect(ask(closedOn("2026-08-31"), { enabled: true, days: 10 })).toBeNull();
      expect(ask(closedOn("2026-08-30"), { enabled: true, days: 10 })).toBe("SELF_SERVICE_WINDOW");
      expect(ask(closedOn("2026-08-31"), { enabled: true, days: 9 })).toBe("SELF_SERVICE_WINDOW");
    });

    it("refuses a date after today", () => {
      expect(ask(closedOn("2026-09-11"), { enabled: true, days: 7 })).toBe("SELF_SERVICE_WINDOW");
    });

    it("lets a session that is still open through, whatever day it started", () => {
      expect(
        ask({ endedAt: null, businessDate: "2026-09-01" }, { enabled: true, days: 0 })
      ).toBeNull();
    });

    it("reads today in the organization's zone, not the server's", () => {
      // 22:30 UTC is already the 11th in Prague, so the 4th is seven days back
      // there and eight in UTC.
      const lateEvening = at("2026-09-10T22:30:00Z");
      const session = closedOn("2026-09-04");

      expect(ask(session, { enabled: true, days: 7 }, { now: lateEvening })).toBeNull();
      expect(ask(closedOn("2026-09-03"), { enabled: true, days: 7 }, { now: lateEvening })).toBe(
        "SELF_SERVICE_WINDOW"
      );
      expect(
        ask(
          closedOn("2026-09-11"),
          { enabled: true, days: 0 },
          { now: lateEvening, timezone: "UTC" }
        )
      ).toBe("SELF_SERVICE_WINDOW");
      expect(
        ask(closedOn("2026-09-11"), { enabled: true, days: 0 }, { now: lateEvening })
      ).toBeNull();
    });
  });

  describe("on with no limit", () => {
    it("allows a date months back", () => {
      expect(ask(closedOn("2026-03-02"), { enabled: true, days: null })).toBeNull();
    });
  });

  describe("an ended Employment", () => {
    it("is refused whatever the setting, an open session included", () => {
      for (const window of [
        { enabled: true, days: null },
        { enabled: true, days: 0 },
        { enabled: false, days: 0 },
      ]) {
        expect(ask(closedOn("2026-09-10"), window, { employmentEnded: true })).toBe(
          "EMPLOYMENT_ENDED"
        );
        expect(
          ask({ endedAt: null, businessDate: "2026-09-10" }, window, { employmentEnded: true })
        ).toBe("EMPLOYMENT_ENDED");
      }
    });
  });
});
