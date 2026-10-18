import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { getUserLanguage } from "../userSettings/userSettingsServices.js";

export type RecordTypeLabels = Readonly<Record<CalendarRecordType, string>>;

export const ENGLISH_RECORD_TYPE_LABELS: RecordTypeLabels = {
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

const CZECH: RecordTypeLabels = {
  [CalendarRecordType.Vacation]: "Dovolená",
  [CalendarRecordType.HomeOffice]: "Home office",
  [CalendarRecordType.Sick]: "Nemoc",
  [CalendarRecordType.BankHoliday]: "Státní svátek",
  [CalendarRecordType.NonPaidLeave]: "Neplacené volno",
  [CalendarRecordType.PaidTimeOff]: "Placené volno",
  [CalendarRecordType.SickDay]: "Zdravotní volno",
  [CalendarRecordType.StudyLeave]: "Studijní volno",
  [CalendarRecordType.Other]: "Ostatní",
};

const TABLES: Readonly<Record<appLanguage, RecordTypeLabels>> = {
  [appLanguage.English]: ENGLISH_RECORD_TYPE_LABELS,
  [appLanguage.Czech]: CZECH,
};

/**
 * Record type labels in a language, English when there is no table for it.
 * Every backend surface that names a record type reads this table.
 */
export const recordTypeLabels = (language: string | null | undefined): RecordTypeLabels =>
  language && Object.hasOwn(TABLES, language)
    ? TABLES[language as appLanguage]
    : ENGLISH_RECORD_TYPE_LABELS;

export const userRecordTypeLabels = async (userId: string): Promise<RecordTypeLabels> =>
  recordTypeLabels(await getUserLanguage(userId));

/** A birthday's title on feeds and synced calendars, in the feed owner's language. */
export const birthdayLabel = (language: string | null | undefined): string =>
  language === appLanguage.Czech ? "Narozeniny" : "Birthday";
