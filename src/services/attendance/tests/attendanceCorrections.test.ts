import { describe, it, expect } from "vitest";
import {
  applyCorrection,
  assertCoherent,
  nextChangedAfterDay,
  overlappingBreak,
} from "../attendanceCorrections.js";
import { AttendanceCorrectionRight } from "../types.js";

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

describe("overlappingBreak", () => {
  const sessionEnd = at("2026-09-09T15:00:00Z");
  const lunch = entry("lunch", "2026-09-09T12:00:00Z", "2026-09-09T12:30:00Z");

  it("finds the break a new one runs into", () => {
    const candidate = entry("new", "2026-09-09T12:20:00Z", "2026-09-09T12:45:00Z");

    expect(overlappingBreak(candidate, [lunch], sessionEnd)?.id).toBe("lunch");
  });

  it("finds a break the new one swallows whole", () => {
    const candidate = entry("new", "2026-09-09T11:30:00Z", "2026-09-09T13:00:00Z");

    expect(overlappingBreak(candidate, [lunch], sessionEnd)?.id).toBe("lunch");
  });

  it("lets breaks sit back to back", () => {
    const after = entry("new", "2026-09-09T12:30:00Z", "2026-09-09T12:45:00Z");
    const before = entry("new", "2026-09-09T11:45:00Z", "2026-09-09T12:00:00Z");

    expect(overlappingBreak(after, [lunch], sessionEnd)).toBeUndefined();
    expect(overlappingBreak(before, [lunch], sessionEnd)).toBeUndefined();
  });

  it("does not hold a break against itself", () => {
    const moved = entry("lunch", "2026-09-09T12:10:00Z", "2026-09-09T12:40:00Z");

    expect(overlappingBreak(moved, [lunch], sessionEnd)).toBeUndefined();
  });

  it("counts a break left open to the session's end", () => {
    const leftOpen = entry("open", "2026-09-09T14:00:00Z", null);
    const candidate = entry("new", "2026-09-09T14:30:00Z", "2026-09-09T14:45:00Z");

    expect(overlappingBreak(candidate, [leftOpen], sessionEnd)?.id).toBe("open");
  });
});

describe("nextChangedAfterDay", () => {
  const today = "2026-09-10";

  it("flags a session its owner changes after its business date", () => {
    expect(
      nextChangedAfterDay({
        right: AttendanceCorrectionRight.Self,
        businessDate: "2026-09-09",
        today,
        wasFlagged: false,
      })
    ).toBe(true);
  });

  it("leaves a session its owner changes on its own day unflagged", () => {
    expect(
      nextChangedAfterDay({
        right: AttendanceCorrectionRight.Self,
        businessDate: today,
        today,
        wasFlagged: false,
      })
    ).toBe(false);
  });

  it("keeps the flag when the owner changes it again on a later day", () => {
    expect(
      nextChangedAfterDay({
        right: AttendanceCorrectionRight.Self,
        businessDate: today,
        today,
        wasFlagged: true,
      })
    ).toBe(true);
  });

  it("clears the flag on any admin write, and never sets it", () => {
    for (const wasFlagged of [true, false]) {
      expect(
        nextChangedAfterDay({
          right: AttendanceCorrectionRight.Admin,
          businessDate: "2026-09-01",
          today,
          wasFlagged,
        })
      ).toBe(false);
    }
  });
});
