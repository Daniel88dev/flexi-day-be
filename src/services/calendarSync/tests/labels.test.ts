import { describe, it, expect } from "vitest";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import { recordTypeLabels } from "../labels.js";

describe("recordTypeLabels", () => {
  it("names every record type in English", () => {
    expect(recordTypeLabels("en")).toEqual({
      [CalendarRecordType.Vacation]: "Vacation",
      [CalendarRecordType.HomeOffice]: "Home office",
      [CalendarRecordType.Sick]: "Sick",
      [CalendarRecordType.BankHoliday]: "Bank holiday",
      [CalendarRecordType.NonPaidLeave]: "Non-paid leave",
      [CalendarRecordType.PaidTimeOff]: "Paid time off",
      [CalendarRecordType.SickDay]: "Sick day",
      [CalendarRecordType.StudyLeave]: "Study leave",
      [CalendarRecordType.Other]: "Other",
    });
  });

  it("falls back to English for a language it has no table for", () => {
    expect(recordTypeLabels("xx")[CalendarRecordType.StudyLeave]).toBe("Study leave");
    expect(recordTypeLabels(undefined)[CalendarRecordType.Vacation]).toBe("Vacation");
  });
});
