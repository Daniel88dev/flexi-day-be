import type { DbTransaction } from "../../db/db.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";
import { getLiveGroupIdsForOrganizationOrdered } from "../group/groupServices.js";
import { listExcusingAbsences } from "../vacation/vacationServices.js";
import { getNonWorkingDays } from "../workingDays/workingDaysServices.js";
import { NonWorkingDayCause, type WorkingDayRules } from "../workingDays/types.js";
import {
  AttendanceExclusionCause,
  AttendanceExclusionExtent,
  type DayExclusion,
} from "./attendanceCalculation.js";

export type AttendanceExclusionInput = {
  organizationId: string;
  userId: string;
  /** The current spell. Dates either side of it are excluded outright. */
  employment: { startedAt: Date; endedAt: Date | null };
  dates: DateString[];
  rules: WorkingDayRules;
  /** The organization's zone, which is what turns the spell's instants into dates. */
  timezone: string;
};

const full = (cause: AttendanceExclusionCause, label: string | null = null): DayExclusion => ({
  cause,
  extent: AttendanceExclusionExtent.Full,
  label,
});

/**
 * What each business date of a range is excused from, ready for
 * `computeAttendance`. Three sources, in the order they overrule each other:
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
export const getAttendanceExclusions = async (
  { organizationId, userId, employment, dates, rules, timezone }: AttendanceExclusionInput,
  tx?: DbTransaction
): Promise<Map<DateString, DayExclusion>> => {
  const exclusions = new Map<DateString, DayExclusion>();
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (from === undefined || to === undefined) return exclusions;

  const employedFrom = businessDateInZone(employment.startedAt, timezone);
  const employedTo =
    employment.endedAt === null ? null : businessDateInZone(employment.endedAt, timezone);

  for (const date of dates) {
    if (date < employedFrom || (employedTo !== null && date > employedTo)) {
      exclusions.set(date, full(AttendanceExclusionCause.NotEmployed));
    }
  }

  const nonWorking = await getNonWorkingDays(rules, from, to, tx);
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

  const groupIds = await getLiveGroupIdsForOrganizationOrdered(organizationId, tx);
  if (groupIds.length === 0) return exclusions;

  const absences = await listExcusingAbsences(userId, groupIds, from, to, tx);
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
