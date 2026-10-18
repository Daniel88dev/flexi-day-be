import { describe, expect, it } from "vitest";
import { planGroupEventDelete, planGroupEventEdit } from "../editPlan.js";
import type { GroupEventRecord } from "../types.js";

const row = (patch: Partial<GroupEventRecord> = {}): GroupEventRecord => ({
  id: "weekly",
  groupId: "group",
  createdByUserId: "creator",
  title: "Standup",
  note: null,
  startDate: "2026-11-03",
  endDate: "2026-11-03",
  startTime: "09:00:00",
  endTime: "09:30:00",
  repeatFreq: "WEEKLY",
  repeatInterval: 1,
  repeatWeekdays: [1],
  repeatMonthlyMode: null,
  repeatUntil: null,
  skippedDates: [],
  recurringEventId: null,
  originalDate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  ...patch,
});

const oneOff = (id: string, originalDate: string): GroupEventRecord =>
  row({
    id,
    title: `Moved ${originalDate}`,
    startDate: originalDate,
    endDate: originalDate,
    repeatFreq: null,
    repeatInterval: null,
    repeatWeekdays: null,
    recurringEventId: "weekly",
    originalDate,
  });

const newId = () => "split";

describe("planGroupEventEdit", () => {
  it("drops only the one-off changes from the split date on when following changes the rule", () => {
    const event = row({ skippedDates: ["2026-11-10", "2026-11-24", "2026-12-01"] });
    const oneOffs = [oneOff("early", "2026-11-10"), oneOff("late", "2026-11-24")];

    const plan = planGroupEventEdit(
      event,
      oneOffs,
      {
        scope: "following",
        occurrenceDate: "2026-11-17",
        changes: {
          repeat: { freq: "weekly", interval: 2, weekdays: [1], monthlyMode: null, until: null },
        },
      },
      newId
    );

    // The later one-off and the plain deletion on 1 December; the earlier one-off stays.
    expect(plan.droppedOneOffs).toBe(2);
    expect(plan.tombstones).toEqual(["late"]);
    expect(plan.needsActivePlan).toBe(true);
    expect(plan.inserts[0]).toMatchObject({ id: "split", repeatInterval: 2, skippedDates: [] });
    expect(plan.updates[0]).toEqual({
      id: "weekly",
      set: expect.objectContaining({ repeatUntil: "2026-11-16", skippedDates: ["2026-11-10"] }),
    });
  });

  it("needs an active plan when a one-off gains a repeat rule, not for its other edits", () => {
    const single = oneOff("single", "2026-11-12");
    const repeat = {
      freq: "weekly" as const,
      interval: 1,
      weekdays: [3],
      monthlyMode: null,
      until: null,
    };

    expect(planGroupEventEdit(single, [], { changes: { repeat } }, newId).needsActivePlan).toBe(
      true
    );
    expect(
      planGroupEventEdit(single, [], { changes: { title: "Renamed" } }, newId).needsActivePlan
    ).toBe(false);
  });

  it("leaves one-offs alone through all events when nothing they carry changed", () => {
    const plan = planGroupEventEdit(
      row({ skippedDates: ["2026-11-10"] }),
      [oneOff("moved", "2026-11-10")],
      { scope: "all", changes: { title: "Standup", startTime: "09:00" } },
      newId
    );

    expect(plan.droppedOneOffs).toBe(0);
    expect(plan.updates.map((update) => update.id)).toEqual(["weekly"]);
  });

  it("accepts the current rule unchanged on a this event edit", () => {
    const plan = planGroupEventEdit(
      row(),
      [],
      {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: {
          title: "Once",
          repeat: { freq: "weekly", interval: 1, weekdays: [1], monthlyMode: null, until: null },
        },
      },
      newId
    );

    expect(plan.inserts[0]).toMatchObject({ title: "Once", repeatFreq: null });
  });

  it("unlinks a one-off that starts repeating", () => {
    const plan = planGroupEventEdit(
      oneOff("moved", "2026-11-10"),
      [],
      {
        changes: {
          repeat: { freq: "daily", interval: 1, weekdays: [], monthlyMode: null, until: null },
        },
      },
      newId
    );

    expect(plan.updates[0]!.set).toMatchObject({
      repeatFreq: "DAILY",
      recurringEventId: null,
      originalDate: null,
    });
  });
});

describe("planGroupEventDelete", () => {
  it("deletes everything with this and following from the first occurrence", () => {
    const plan = planGroupEventDelete(row(), [oneOff("moved", "2026-11-10")], {
      scope: "following",
      occurrenceDate: "2026-11-03",
    });

    expect(plan.tombstones).toEqual(["weekly", "moved"]);
    expect(plan.updates).toEqual([]);
  });

  it("ignores the scope on a one-off", () => {
    const plan = planGroupEventDelete(oneOff("moved", "2026-11-10"), [], { scope: "this" });
    expect(plan.tombstones).toEqual(["moved"]);
  });
});
