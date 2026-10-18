import { describe, it, expect } from "vitest";
import { spanRefusal } from "../sessionSpan.js";

const at = (iso: string) => new Date(iso);

describe("spanRefusal", () => {
  // Friday 11 September 2026, 12:00 in Prague.
  const now = at("2026-09-11T10:00:00Z");

  const ask = (businessDate: string, startedAt: string, endedAt: string | null, ceiling = 960) =>
    spanRefusal({
      businessDate,
      startedAt: at(startedAt),
      endedAt: endedAt === null ? null : at(endedAt),
      timezone: "Europe/Prague",
      now,
      ceilingMinutes: ceiling,
    });

  it("holds an open session's start to its business date", () => {
    expect(ask("2026-09-11", "2026-09-11T06:00:00Z", null)).toBeNull();
    expect(ask("2026-09-11", "2026-09-09T06:00:00Z", null)).toBe("START_OFF_DATE");
  });

  it("refuses an open session's start later than now, and takes one exactly now", () => {
    expect(ask("2026-09-11", "2026-09-11T10:00:01Z", null)).toBe("START_IN_FUTURE");
    expect(ask("2026-09-11", "2026-09-11T10:00:00Z", null)).toBeNull();
  });

  it("names the end, not the start, when a closed span runs past now", () => {
    expect(ask("2026-09-11", "2026-09-11T10:30:00Z", "2026-09-11T11:00:00Z")).toBe("END_IN_FUTURE");
  });

  it("takes a span exactly as long as the ceiling, which is where the sweep closes one", () => {
    expect(ask("2026-09-08", "2026-09-08T04:00:00Z", "2026-09-08T20:00:00Z")).toBeNull();
    expect(ask("2026-09-08", "2026-09-08T04:00:00Z", "2026-09-08T20:00:01Z")).toBe("OVER_CEILING");
  });

  it("puts no ceiling on a session still open", () => {
    expect(ask("2026-09-10", "2026-09-10T04:00:00Z", null)).toBeNull();
  });
});
