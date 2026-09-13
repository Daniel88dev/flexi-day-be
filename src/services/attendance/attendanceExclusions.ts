import type { DbTransaction } from "../../db/db.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";
import { getLiveGroupIdsForOrganizationOrdered } from "../group/groupServices.js";
import { listExcusingAbsencesForUsers } from "../vacation/vacationServices.js";
import type { ExcusingAbsence } from "../vacation/types.js";
import { getNonWorkingDays } from "../workingDays/workingDaysServices.js";
import {
  NonWorkingDayCause,
  type NonWorkingDay,
  type WorkingDayRules,
} from "../workingDays/types.js";
import {
  AttendanceExclusionCause,
  AttendanceExclusionExtent,
  type DayExclusion,
} from "./attendanceCalculation.js";

/** The current spell. Dates either side of it are excluded outright. */
type EmploymentSpell = { startedAt: Date; endedAt: Date | null };

export type AttendanceExclusionInput = {
  organizationId: string;
  userId: string;
  employment: EmploymentSpell;
  dates: DateString[];
  rules: WorkingDayRules;
  /** The organization's zone, which is what turns the spell's instants into dates. */
  timezone: string;
};

export type AttendanceExclusionsForPeopleInput = {
  organizationId: string;
  people: { userId: string; employment: EmploymentSpell }[];
  dates: DateString[];
  rules: WorkingDayRules;
  timezone: string;
};

const full = (cause: AttendanceExclusionCause, label: string | null = null): DayExclusion => ({
  cause,
  extent: AttendanceExclusionExtent.Full,
  label,
});

/**
 * One person's exclusions from the pieces already read. Three sources, in the
 * order they overrule each other:
 *
 * 1. the Employment's own spell — a date outside it was never this person's to
 *    work, which is a blunter fact than any day off;
 * 2. the organization's working days and its country's public holidays;
 * 3. the person's approved absences in any group of the organization, which
 *    alone can halve a day rather than take it.
 *
 * An absence landing on a day nobody works changes nothing: the day is already
 * gone, and "half a Saturday" is not a figure anybody wants to read.
 */
const buildExclusions = (
  employment: EmploymentSpell,
  dates: DateString[],
  timezone: string,
  nonWorking: Map<DateString, NonWorkingDay>,
  absences: ExcusingAbsence[]
): Map<DateString, DayExclusion> => {
  const exclusions = new Map<DateString, DayExclusion>();

  const employedFrom = businessDateInZone(employment.startedAt, timezone);
  const employedTo =
    employment.endedAt === null ? null : businessDateInZone(employment.endedAt, timezone);

  for (const date of dates) {
    if (date < employedFrom || (employedTo !== null && date > employedTo)) {
      exclusions.set(date, full(AttendanceExclusionCause.NotEmployed));
    }
  }

  for (const [date, day] of nonWorking) {
    if (exclusions.has(date)) continue;
    exclusions.set(
      date,
      full(
        day.cause === NonWorkingDayCause.Holiday
          ? AttendanceExclusionCause.Holiday
          : AttendanceExclusionCause.NonWorkingDay,
        day.name
      )
    );
  }

  for (const absence of absences) {
    if (exclusions.has(absence.requestedDay)) continue;
    exclusions.set(absence.requestedDay, {
      cause: AttendanceExclusionCause.Absence,
      extent: absence.halfDay ? AttendanceExclusionExtent.Half : AttendanceExclusionExtent.Full,
      label: absence.vacationType,
    });
  }

  return exclusions;
};

/**
 * What each business date of a range excuses each person from, keyed by user
 * id and ready for `computeAttendance`. The calendar and the absences are read
 * once for everybody; only the spell is each person's own.
 */
export const getAttendanceExclusionsForPeople = async (
  { organizationId, people, dates, rules, timezone }: AttendanceExclusionsForPeopleInput,
  tx?: DbTransaction
): Promise<Map<string, Map<DateString, DayExclusion>>> => {
  const byUser = new Map<string, Map<DateString, DayExclusion>>();
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (people.length === 0 || from === undefined || to === undefined) {
    for (const person of people) byUser.set(person.userId, new Map());
    return byUser;
  }

  const nonWorking = await getNonWorkingDays(rules, from, to, tx);

  const groupIds = await getLiveGroupIdsForOrganizationOrdered(organizationId, tx);
  const absences =
    groupIds.length === 0
      ? []
      : await listExcusingAbsencesForUsers(
          people.map((person) => person.userId),
          groupIds,
          from,
          to,
          tx
        );

  for (const person of people) {
    byUser.set(
      person.userId,
      buildExclusions(
        person.employment,
        dates,
        timezone,
        nonWorking,
        absences.filter((absence) => absence.userId === person.userId)
      )
    );
  }

  return byUser;
};

/** {@link getAttendanceExclusionsForPeople} for one person. */
export const getAttendanceExclusions = async (
  { organizationId, userId, employment, dates, rules, timezone }: AttendanceExclusionInput,
  tx?: DbTransaction
): Promise<Map<DateString, DayExclusion>> => {
  const byUser = await getAttendanceExclusionsForPeople(
    { organizationId, people: [{ userId, employment }], dates, rules, timezone },
    tx
  );
  return byUser.get(userId) ?? new Map();
};
