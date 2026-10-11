import { CalendarRecordType } from "../../db/schema/vacation-schema.js";

export type RecordTypeLabels = Readonly<Record<CalendarRecordType, string>>;

const ENGLISH: RecordTypeLabels = {
  [CalendarRecordType.Vacation]: "Vacation",
  [CalendarRecordType.HomeOffice]: "Home office",
  [CalendarRecordType.Sick]: "Sick",
  [CalendarRecordType.BankHoliday]: "Bank holiday",
  [CalendarRecordType.NonPaidLeave]: "Non-paid leave",
  [CalendarRecordType.PaidTimeOff]: "Paid time off",
  [CalendarRecordType.SickDay]: "Sick day",
  [CalendarRecordType.StudyLeave]: "Study leave",
  [CalendarRecordType.Other]: "Other",
};

const TABLES: ReadonlyMap<string, RecordTypeLabels> = new Map([["en", ENGLISH]]);

/**
 * Record type labels in a language, English when there is no table for it.
 * The `.ics` feed and direct sync both read this, so they say the same word.
 */
export const recordTypeLabels = (language: string | null | undefined): RecordTypeLabels =>
  (language ? TABLES.get(language) : undefined) ?? ENGLISH;
