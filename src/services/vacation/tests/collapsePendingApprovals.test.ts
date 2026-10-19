import { describe, it, expect } from "vitest";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import { collapsePendingApprovals } from "../collapsePendingApprovals.js";
import type { PendingApprovalRow } from "../vacationServices.js";

const row = (
  vacationId: string,
  requestId: string,
  requestedDay: string,
  overrides: Partial<PendingApprovalRow> = {}
): PendingApprovalRow => ({
  vacationId,
  requestId,
  userId: "user-mia",
  userName: "Mia Lind",
  groupId: "group-a",
  groupName: "Team A",
  vacationType: CalendarRecordType.Vacation,
  requestedDay,
  note: null,
  submittedAt: new Date("2026-12-01T09:00:00Z"),
  ...overrides,
});

describe("collapsePendingApprovals", () => {
  it("keeps a Request that spans a weekend as one item", () => {
    const items = collapsePendingApprovals([
      row("thu", "req-1", "2026-12-24"),
      row("fri", "req-1", "2026-12-25"),
      row("mon", "req-1", "2026-12-28"),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      vacationIds: ["thu", "fri", "mon"],
      from: "2026-12-24",
      to: "2026-12-28",
      businessDays: 3,
    });
  });

  it("keeps two Requests on adjacent days apart, each with its own note", () => {
    const items = collapsePendingApprovals([
      row("a1", "req-a", "2026-12-14", { note: "first trip" }),
      row("a2", "req-a", "2026-12-15", { note: "first trip" }),
      row("b1", "req-b", "2026-12-16", { note: "second trip" }),
      row("b2", "req-b", "2026-12-17", { note: "second trip" }),
    ]);

    expect(
      items.map(({ vacationIds, from, to, note }) => ({ vacationIds, from, to, note }))
    ).toEqual([
      { vacationIds: ["a1", "a2"], from: "2026-12-14", to: "2026-12-15", note: "first trip" },
      { vacationIds: ["b1", "b2"], from: "2026-12-16", to: "2026-12-17", note: "second trip" },
    ]);
  });

  it("counts the days the item books, not the weekdays between its ends", () => {
    // Wed 23 to Mon 28 Dec with Fri 25 skipped as a public holiday: four rows.
    const items = collapsePendingApprovals([
      row("wed", "req-1", "2026-12-23"),
      row("thu", "req-1", "2026-12-24"),
      row("mon", "req-1", "2026-12-28"),
      row("tue", "req-1", "2026-12-29"),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.businessDays).toBe(4);
  });

  it("covers only the still-pending days of a partly decided Request", () => {
    // Tue 15 was approved already, so only Mon 14 and Wed 16 come in.
    const items = collapsePendingApprovals([
      row("mon", "req-1", "2026-12-14"),
      row("wed", "req-1", "2026-12-16"),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      vacationIds: ["mon", "wed"],
      from: "2026-12-14",
      to: "2026-12-16",
      businessDays: 2,
    });
  });

  it("does not need a Request's rows to sit next to each other in the input", () => {
    const items = collapsePendingApprovals([
      row("a1", "req-a", "2026-12-14"),
      row("b1", "req-b", "2026-12-15"),
      row("a2", "req-a", "2026-12-16"),
    ]);

    expect(items.map((item) => item.vacationIds)).toEqual([["a1", "a2"], ["b1"]]);
  });

  it("keeps the earliest submission time of the Request", () => {
    const items = collapsePendingApprovals([
      row("a1", "req-a", "2026-12-14", { submittedAt: new Date("2026-12-02T09:00:00Z") }),
      row("a2", "req-a", "2026-12-15", { submittedAt: new Date("2026-12-01T09:00:00Z") }),
    ]);

    expect(items[0]?.submittedAt).toBe("2026-12-01T09:00:00.000Z");
  });

  it("separates users, groups and types even within one request id", () => {
    const items = collapsePendingApprovals([
      row("a", "req-1", "2026-12-14"),
      row("b", "req-1", "2026-12-15", { groupId: "group-b", groupName: "Team B" }),
      row("c", "req-1", "2026-12-16", { vacationType: CalendarRecordType.HomeOffice }),
      row("d", "req-1", "2026-12-17", { userId: "user-otto", userName: "Otto Berg" }),
    ]);

    expect(items.map((item) => item.vacationIds)).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });
});
