import { describe, it, expect } from "vitest";
import {
  computeRolloverRow,
  describeRollover,
  type RolloverCandidate,
} from "../computeRollover.js";

const candidate = (over: Partial<RolloverCandidate> = {}): RolloverCandidate => ({
  userId: "u1",
  groupId: "g1",
  previousVacationDays: 20,
  previousHomeOfficeDays: 5,
  previousSickDays: 2,
  previousCarriedOverDays: 0,
  previousUsedDays: 12,
  groupDefaultVacationDays: 25,
  groupDefaultHomeOfficeDays: 10,
  groupDefaultSickDays: 3,
  ...over,
});

describe("computeRolloverRow", () => {
  it("carries the member's own allowance forward, not the group default", () => {
    const row = computeRolloverRow(candidate());

    expect(row).toMatchObject({ vacationDays: 20, homeOfficeDays: 5, sickDays: 2 });
  });

  it("carries the sick day allocation forward without any unused balance", () => {
    // "No carry-over" means the unused sick days expire — the configured
    // allocation itself must survive the year boundary like the others.
    const row = computeRolloverRow(candidate({ previousSickDays: 4 }));

    expect(row.sickDays).toBe(4);
    expect(row.carriedOverDays).toBe(8);
  });

  it("rolls unused days into the carry-over", () => {
    expect(computeRolloverRow(candidate()).carriedOverDays).toBe(8);
  });

  it("includes last year's own carry-over in what rolls forward", () => {
    const row = computeRolloverRow(candidate({ previousCarriedOverDays: 3, previousUsedDays: 12 }));

    expect(row.carriedOverDays).toBe(11);
  });

  it("falls back to the group defaults for a member with no previous year", () => {
    const row = computeRolloverRow(
      candidate({
        previousVacationDays: null,
        previousHomeOfficeDays: null,
        previousSickDays: null,
        previousCarriedOverDays: null,
        previousUsedDays: 0,
      })
    );

    expect(row).toMatchObject({
      vacationDays: 25,
      homeOfficeDays: 10,
      sickDays: 3,
      carriedOverDays: 25,
    });
  });

  it("never carries a negative balance into the new year", () => {
    const row = computeRolloverRow(candidate({ previousUsedDays: 30 }));

    expect(row.carriedOverDays).toBe(0);
  });

  it("floors a half-day remainder, since the column holds whole days", () => {
    const row = computeRolloverRow(candidate({ previousUsedDays: 11.5 }));

    expect(row.carriedOverDays).toBe(8);
  });

  it("carries nothing forward when the allowance was used exactly", () => {
    expect(computeRolloverRow(candidate({ previousUsedDays: 20 })).carriedOverDays).toBe(0);
  });

  it("carries a zero allowance forward as zero rather than the group default", () => {
    const row = computeRolloverRow(
      candidate({ previousVacationDays: 0, previousUsedDays: 0, previousCarriedOverDays: 0 })
    );

    expect(row).toMatchObject({ vacationDays: 0, carriedOverDays: 0 });
  });

  it("keeps the membership it was derived from", () => {
    const row = computeRolloverRow(candidate({ userId: "u9", groupId: "g9" }));

    expect(row).toMatchObject({ userId: "u9", groupId: "g9" });
  });
});

describe("describeRollover", () => {
  it("names the year, the allowance and where the carry-over came from", () => {
    const detail = describeRollover(2027, {
      userId: "u1",
      groupId: "g1",
      vacationDays: 20,
      homeOfficeDays: 5,
      sickDays: 2,
      carriedOverDays: 8,
    });

    expect(detail).toBe(
      "Quota for 2027 opened automatically: 20 vacation / 5 home office / 2 sick days, " +
        "8 carried over from 2026"
    );
  });
});
