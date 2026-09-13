import { describe, it, expect } from "vitest";
import {
  applyCorrection,
  assertCoherent,
  withinSelfServiceWindow,
} from "../attendanceCorrections.js";

const PRAGUE = "Europe/Prague";

const at = (iso: string) => new Date(iso);

const span = (startedAt: string, endedAt: string | null) => ({
  startedAt: at(startedAt),
  endedAt: endedAt === null ? null : at(endedAt),
});

const entry = (id: string, startedAt: string, endedAt: string | null) => ({
  id,
  ...span(startedAt, endedAt),
});

const reasonOf = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    const [first] = (error as { errors: { publicContext: { reason?: string } }[] }).errors;
    return first?.publicContext.reason ?? "";
  }
  return "";
};

describe("applyCorrection", () => {
  it("leaves an absent key alone", () => {
    const result = applyCorrection(span("2026-09-09T06:05:00Z", "2026-09-09T15:10:00Z"), {
      startedAt: "2026-09-09T07:00:00Z",
    });

    expect(result.startedAt.toISOString()).toBe("2026-09-09T07:00:00.000Z");
    expect(result.endedAt?.toISOString()).toBe("2026-09-09T15:10:00.000Z");
  });

  it("reopens on an explicit null, which an absent key never does", () => {
    const closed = span("2026-09-09T06:05:00Z", "2026-09-09T15:10:00Z");

    expect(applyCorrection(closed, { endedAt: null }).endedAt).toBeNull();
    expect(applyCorrection(closed, { startedAt: "2026-09-09T07:00:00Z" }).endedAt).not.toBeNull();
  });

  it("moves both ends at once", () => {
    const result = applyCorrection(span("2026-09-09T06:05:00Z", null), {
      startedAt: "2026-09-09T06:00:00Z",
      endedAt: "2026-09-09T15:00:00Z",
    });

    expect(result.startedAt.toISOString()).toBe("2026-09-09T06:00:00.000Z");
    expect(result.endedAt?.toISOString()).toBe("2026-09-09T15:00:00.000Z");
  });
});

describe("assertCoherent", () => {
  it("accepts a session with its breaks inside it", () => {
    expect(() =>
      assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T15:00:00Z"), [
        entry("b1", "2026-09-09T10:00:00Z", "2026-09-09T10:30:00Z"),
        entry("b2", "2026-09-09T12:00:00Z", "2026-09-09T12:15:00Z"),
      ])
    ).not.toThrow();
  });

  it("refuses a session that ends before it starts", () => {
    expect(
      reasonOf(() => assertCoherent(span("2026-09-09T15:00:00Z", "2026-09-09T06:00:00Z"), []))
    ).toBe("END_BEFORE_START");
  });

  it("refuses a session of no length at all", () => {
    expect(
      reasonOf(() => assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T06:00:00Z"), []))
    ).toBe("END_BEFORE_START");
  });

  it("refuses a break that ends before it starts", () => {
    expect(
      reasonOf(() =>
        assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T15:00:00Z"), [
          entry("b1", "2026-09-09T12:30:00Z", "2026-09-09T12:00:00Z"),
        ])
      )
    ).toBe("END_BEFORE_START");
  });

  it("refuses a break that starts before its session", () => {
    expect(
      reasonOf(() =>
        assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T15:00:00Z"), [
          entry("b1", "2026-09-09T05:30:00Z", "2026-09-09T06:30:00Z"),
        ])
      )
    ).toBe("BREAK_OUTSIDE_SESSION");
  });

  it("refuses a break that outlives its session", () => {
    expect(
      reasonOf(() =>
        assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T15:00:00Z"), [
          entry("b1", "2026-09-09T14:30:00Z", "2026-09-09T15:30:00Z"),
        ])
      )
    ).toBe("BREAK_OUTSIDE_SESSION");
  });

  it("refuses a break that begins after its session has ended", () => {
    expect(
      reasonOf(() =>
        assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T15:00:00Z"), [
          entry("b1", "2026-09-09T16:00:00Z", "2026-09-09T16:30:00Z"),
        ])
      )
    ).toBe("BREAK_OUTSIDE_SESSION");
  });

  it("keeps an open break under a closed session, which is what the sweep leaves", () => {
    expect(() =>
      assertCoherent(span("2026-09-09T06:00:00Z", "2026-09-09T15:00:00Z"), [
        entry("b1", "2026-09-09T14:00:00Z", null),
      ])
    ).not.toThrow();
  });

  it("bounds a break of an open session by its start alone", () => {
    expect(() =>
      assertCoherent(span("2026-09-09T06:00:00Z", null), [
        entry("b1", "2026-09-09T23:00:00Z", null),
      ])
    ).not.toThrow();

    expect(
      reasonOf(() =>
        assertCoherent(span("2026-09-09T06:00:00Z", null), [
          entry("b1", "2026-09-09T05:00:00Z", null),
        ])
      )
    ).toBe("BREAK_OUTSIDE_SESSION");
  });
});

describe("withinSelfServiceWindow", () => {
  const now = at("2026-09-10T08:00:00Z");

  it("lets the person change a session that is still open, whatever day it started", () => {
    expect(
      withinSelfServiceWindow({ endedAt: null, businessDate: "2026-09-01" }, PRAGUE, now)
    ).toBe(true);
  });

  it("lets the person change a closed session on today's business date", () => {
    expect(
      withinSelfServiceWindow(
        { endedAt: at("2026-09-10T07:00:00Z"), businessDate: "2026-09-10" },
        PRAGUE,
        now
      )
    ).toBe(true);
  });

  it("closes the window on yesterday", () => {
    expect(
      withinSelfServiceWindow(
        { endedAt: at("2026-09-09T15:00:00Z"), businessDate: "2026-09-09" },
        PRAGUE,
        now
      )
    ).toBe(false);
  });

  it("reads today in the organization's zone, not the server's", () => {
    // 22:30 UTC is already the 11th in Prague, so a session dated the 11th is
    // today there and yesterday in UTC.
    const lateEvening = at("2026-09-10T22:30:00Z");
    const session = { endedAt: at("2026-09-10T22:00:00Z"), businessDate: "2026-09-11" };

    expect(withinSelfServiceWindow(session, PRAGUE, lateEvening)).toBe(true);
    expect(withinSelfServiceWindow(session, "UTC", lateEvening)).toBe(false);
  });
});
