import { describe, it, expect } from "vitest";
import { collapseBookings, type BookingRow } from "../collapseBookings.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";

const row = (overrides: Partial<BookingRow> & { requestedDay: string }): BookingRow => ({
  userId: "u1",
  userName: "Ada Lovelace",
  groupId: "g1",
  groupName: "Engineering",
  vacationType: CalendarRecordType.Vacation,
  halfDay: false,
  approvedAt: new Date("2026-01-01T00:00:00Z"),
  rejectedAt: null,
  note: null,
  ...overrides,
});

describe("collapseBookings", () => {
  it("merges contiguous days into one booking with a summed day count", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12" }),
      row({ requestedDay: "2026-03-13" }),
      row({ requestedDay: "2026-03-14" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ from: "2026-03-12", to: "2026-03-14", days: 3 });
  });

  it("splits on a gap in the dates", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12" }),
      row({ requestedDay: "2026-03-13" }),
      row({ requestedDay: "2026-03-16" }),
    ]);

    expect(result.map((b) => [b.from, b.to])).toEqual([
      ["2026-03-12", "2026-03-13"],
      ["2026-03-16", "2026-03-16"],
    ]);
  });

  it("counts a half day as 0.5", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12", halfDay: true }),
      row({ requestedDay: "2026-03-13" }),
    ]);

    expect(result[0]?.days).toBe(1.5);
  });

  it("does not merge across a status change", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12" }),
      row({ requestedDay: "2026-03-13", approvedAt: null }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((b) => b.status)).toEqual(["approved", "pending"]);
  });

  it("does not merge across a record type change", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12" }),
      row({ requestedDay: "2026-03-13", vacationType: CalendarRecordType.HomeOffice }),
    ]);

    expect(result).toHaveLength(2);
  });

  it("does not merge two members' adjacent days", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12" }),
      row({ requestedDay: "2026-03-13", userId: "u2", userName: "Grace Hopper" }),
    ]);

    expect(result).toHaveLength(2);
  });

  it("marks rejected rows and keeps them separate from approved ones", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12", approvedAt: null, rejectedAt: new Date() }),
    ]);

    expect(result[0]?.status).toBe("rejected");
  });

  it("derives year and month from the first day of the run", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-01-31" }),
      row({ requestedDay: "2026-02-01" }),
    ]);

    expect(result[0]).toMatchObject({ year: 2026, month: 1, days: 2 });
  });

  it("carries the first non-empty note across the run", () => {
    const result = collapseBookings([
      row({ requestedDay: "2026-03-12" }),
      row({ requestedDay: "2026-03-13", note: "conference" }),
    ]);

    expect(result[0]?.note).toBe("conference");
  });

  it("returns an empty array for no rows", () => {
    expect(collapseBookings([])).toEqual([]);
  });
});
