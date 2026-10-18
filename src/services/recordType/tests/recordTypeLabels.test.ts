import { describe, it, expect } from "vitest";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import { AWAY_RECORD_TYPE } from "../../vacation/redaction.js";
import { recordTypeLabels } from "../recordTypeLabels.js";

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
      [AWAY_RECORD_TYPE]: "Away",
    });
  });

  it("names every record type in Czech", () => {
    expect(recordTypeLabels("cs")).toEqual({
      [CalendarRecordType.Vacation]: "Dovolená",
      [CalendarRecordType.HomeOffice]: "Home office",
      [CalendarRecordType.Sick]: "Nemoc",
      [CalendarRecordType.BankHoliday]: "Státní svátek",
      [CalendarRecordType.NonPaidLeave]: "Neplacené volno",
      [CalendarRecordType.PaidTimeOff]: "Placené volno",
      [CalendarRecordType.SickDay]: "Zdravotní volno",
      [CalendarRecordType.StudyLeave]: "Studijní volno",
      [CalendarRecordType.Other]: "Ostatní",
      [AWAY_RECORD_TYPE]: "Pryč",
    });
  });

  it("falls back to English for a language it has no table for", () => {
    expect(recordTypeLabels("xx")[CalendarRecordType.StudyLeave]).toBe("Study leave");
    expect(recordTypeLabels(undefined)[CalendarRecordType.Vacation]).toBe("Vacation");
    expect(recordTypeLabels(null)[CalendarRecordType.Sick]).toBe("Sick");
  });
});
