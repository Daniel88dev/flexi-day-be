import { describe, it, expect } from "vitest";
import { describeQuotaChange } from "../quotaChangeDetail.js";

const values = (
  vacationDays: number,
  homeOfficeDays: number,
  carriedOverDays: number,
  sickDays = 0
) => ({
  vacationDays,
  homeOfficeDays,
  sickDays,
  carriedOverDays,
});

describe("describeQuotaChange", () => {
  it("spells out every value when the member had no quota for the year", () => {
    const detail = describeQuotaChange("2026", undefined, values(25, 5, 3, 2));

    expect(detail).toBe(
      "Quota for 2026 set to 25 vacation / 5 home office / 2 sick days, 3 carried over from the previous year"
    );
  });

  it("names only the fields that moved", () => {
    const detail = describeQuotaChange("2026", values(20, 5, 0), values(25, 5, 0));

    expect(detail).toBe("Quota for 2026: vacation 20 → 25");
  });

  it("reports several changed fields in one line", () => {
    const detail = describeQuotaChange("2026", values(20, 0, 0), values(25, 5, 3));

    expect(detail).toBe("Quota for 2026: vacation 20 → 25, home office 0 → 5, carried over 0 → 3");
  });

  it("reports a carry-over-only edit", () => {
    const detail = describeQuotaChange("2026", values(20, 5, 0), values(20, 5, 4));

    expect(detail).toBe("Quota for 2026: carried over 0 → 4");
  });

  it("reports a sick-day-only edit", () => {
    const detail = describeQuotaChange("2026", values(20, 5, 0, 0), values(20, 5, 0, 3));

    expect(detail).toBe("Quota for 2026: sick day 0 → 3");
  });

  it("still says something when nothing changed", () => {
    const detail = describeQuotaChange("2026", values(20, 5, 0), values(20, 5, 0));

    expect(detail).toBe("Quota for 2026 re-saved with no change");
  });
});
