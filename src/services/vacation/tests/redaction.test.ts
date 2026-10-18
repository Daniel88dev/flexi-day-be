import { describe, it, expect } from "vitest";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import { viewVacationRowAs } from "../redaction.js";

const viewerId = "hUdX9mKq4LpR2wZn7tBvC3sYeA6gJfN1";
const otherId = "pQ8rT2vX5zB7nM4kL1jH6gF3dS9aW0eY";
const ownGroup = "550e8400-e29b-41d4-a716-446655440001";
const sourceGroup = "550e8400-e29b-41d4-a716-446655440002";

const baseRow = {
  id: "row-1",
  userId: otherId,
  groupId: ownGroup,
  vacationType: CalendarRecordType.Sick as CalendarRecordType,
  halfDay: true,
  approvedAt: null as Date | null,
  approvedBy: null as string | null,
  rejectedAt: null as Date | null,
  rejectedBy: null as string | null,
  rejectionReason: null as string | null,
  deletedAt: null as Date | null,
  deletedByUserId: null as string | null,
  note: "a private note" as string | null,
};

const row = (overrides: Partial<typeof baseRow> = {}) => ({ ...baseRow, ...overrides });

const teammate = { userId: viewerId, privilegedGroupIds: new Set<string>() };
const approverOfOwnGroup = { userId: viewerId, privilegedGroupIds: new Set([ownGroup]) };

describe("viewVacationRowAs", () => {
  it("returns the owner's own row unchanged", () => {
    const own = row({ userId: viewerId, rejectedAt: new Date(), rejectionReason: "why" });

    expect(viewVacationRowAs(teammate, own)).toEqual(own);
  });

  it("returns the row unchanged to a privileged reader of its own group", () => {
    const cancelled = row({ deletedAt: new Date(), deletedByUserId: otherId });

    expect(viewVacationRowAs(approverOfOwnGroup, cancelled)).toEqual(cancelled);
  });

  it("shows a teammate Sick as Away, without the note", () => {
    const seen = viewVacationRowAs(teammate, row());

    expect(seen).toMatchObject({
      vacationType: "AWAY",
      note: null,
      halfDay: true,
      approvedAt: null,
    });
  });

  it("leaves every other type as itself for a teammate, Sick day included", () => {
    for (const type of [CalendarRecordType.SickDay, CalendarRecordType.Vacation]) {
      expect(viewVacationRowAs(teammate, row({ vacationType: type }))?.vacationType).toBe(type);
    }
  });

  it("nulls the private fields a row carries, detail-only ones included", () => {
    const approvedAt = new Date("2027-01-02T00:00:00Z");
    const seen = viewVacationRowAs(teammate, {
      ...row({ vacationType: CalendarRecordType.Vacation, approvedAt, approvedBy: otherId }),
      rejectedByUser: null,
      deletedByUser: null,
    });

    expect(seen).toMatchObject({
      vacationType: CalendarRecordType.Vacation,
      approvedAt,
      approvedBy: otherId,
      note: null,
      rejectionReason: null,
      rejectedBy: null,
      deletedByUserId: null,
      rejectedByUser: null,
      deletedByUser: null,
    });
  });

  it("hides another person's rejected or cancelled row from a teammate", () => {
    expect(viewVacationRowAs(teammate, row({ rejectedAt: new Date() }))).toBeNull();
    expect(viewVacationRowAs(teammate, row({ deletedAt: new Date() }))).toBeNull();
  });

  it("keys on the row's own group, so standing in a mirror target counts for nothing", () => {
    const mirrored = row({ groupId: sourceGroup });

    expect(viewVacationRowAs(approverOfOwnGroup, mirrored)?.vacationType).toBe("AWAY");
    expect(
      viewVacationRowAs({ userId: viewerId, privilegedGroupIds: new Set([sourceGroup]) }, mirrored)
        ?.vacationType
    ).toBe(CalendarRecordType.Sick);
  });
});
