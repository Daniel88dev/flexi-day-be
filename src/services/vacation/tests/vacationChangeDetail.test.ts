import { describe, it, expect } from "vitest";
import { describeVacationChanges } from "../vacationChangeDetail.js";
import { vacationType } from "../../../db/schema/vacation-schema.js";

const baseRow = {
  startTime: "09:00:00" as string | null,
  endTime: "17:00:00" as string | null,
  vacationType: vacationType.Vacation,
  halfDay: false,
  note: null as string | null,
};

describe("describeVacationChanges", () => {
  it("names only the fields that actually moved", () => {
    expect(
      describeVacationChanges(baseRow, { vacationType: vacationType.Sick, halfDay: true })
    ).toBe("Type: Vacation → Sick; Half day: no → yes");
  });

  it("summarizes a time change with dashes for cleared values", () => {
    expect(describeVacationChanges(baseRow, { startTime: null, endTime: null })).toBe(
      "Time: 09:00:00–17:00:00 → —–—"
    );
  });

  it("reports note adds, updates and removals without leaking the note text", () => {
    expect(describeVacationChanges(baseRow, { note: "medical" })).toBe("Note added");
    expect(describeVacationChanges({ ...baseRow, note: "old" }, { note: "new" })).toBe(
      "Note updated"
    );
    expect(describeVacationChanges({ ...baseRow, note: "old" }, { note: null })).toBe(
      "Note removed"
    );
  });

  it("falls back to a no-change label when the patch matches the row", () => {
    expect(describeVacationChanges(baseRow, { halfDay: false })).toBe("Re-saved with no change");
  });
});
