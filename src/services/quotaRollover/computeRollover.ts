import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { QuotaFigures } from "../userYearQuotas/types.js";
import {
  allowanceFor,
  resolveYearAllocation,
  totalAllowance,
} from "../userYearQuotas/yearAllocation.js";

/**
 * One active membership that has no quota row yet for the target year, with
 * everything needed to derive one. The previous-year figures fall back to the
 * group defaults when the member has no row for that year either — a joiner
 * with no history still gets a sensible allowance.
 */
export type RolloverCandidate = {
  userId: string;
  groupId: string;
  previousVacationDays: number | null;
  previousHomeOfficeDays: number | null;
  previousSickDays: number | null;
  previousCarriedOverDays: number | null;
  /** Weighted vacation days taken in the previous year; pending counts as spent. */
  previousUsedDays: number;
  groupDefaultVacationDays: number;
  groupDefaultHomeOfficeDays: number;
  groupDefaultSickDays: number;
};

export type RolloverRow = {
  userId: string;
  groupId: string;
  vacationDays: number;
  homeOfficeDays: number;
  sickDays: number;
  carriedOverDays: number;
};

/** The columns come from one left join, so they are all null or none is. */
const previousRow = (candidate: RolloverCandidate): QuotaFigures | undefined =>
  candidate.previousVacationDays === null ||
  candidate.previousHomeOfficeDays === null ||
  candidate.previousSickDays === null ||
  candidate.previousCarriedOverDays === null
    ? undefined
    : {
        vacationDays: candidate.previousVacationDays,
        homeOfficeDays: candidate.previousHomeOfficeDays,
        sickDays: candidate.previousSickDays,
        carriedOverDays: candidate.previousCarriedOverDays,
      };

/**
 * Derives the new year's allowance for one membership.
 *
 * The member's own allowance carries forward — a manually raised quota stays
 * raised next year rather than snapping back to the group default. Unused days
 * land in `carriedOverDays`, floored to a whole day because the column is an
 * integer and half-day bookings can leave a fractional remainder, and clamped
 * at zero so an overdrawn member starts the year level rather than in debt.
 * The sick day allocation carries forward too; only its unused balance
 * expires — sick days never contribute to `carriedOverDays`.
 */
export const computeRolloverRow = (candidate: RolloverCandidate): RolloverRow => {
  const previous = resolveYearAllocation(previousRow(candidate), {
    defaultVacationDays: candidate.groupDefaultVacationDays,
    defaultHomeOfficeDays: candidate.groupDefaultHomeOfficeDays,
    defaultSickDays: candidate.groupDefaultSickDays,
  });

  const previousAllowance = totalAllowance(
    allowanceFor(previous, CalendarRecordType.Vacation, undefined)
  );
  const leftover = previousAllowance - candidate.previousUsedDays;

  return {
    userId: candidate.userId,
    groupId: candidate.groupId,
    vacationDays: previous.vacationDays,
    homeOfficeDays: previous.homeOfficeDays,
    sickDays: previous.sickDays,
    carriedOverDays: Math.max(0, Math.floor(leftover)),
  };
};

/** Audit line shown in the member's "changes by admins" list. */
export const describeRollover = (year: number, row: RolloverRow): string =>
  `Quota for ${year.toString()} opened automatically: ${row.vacationDays.toString()} vacation / ` +
  `${row.homeOfficeDays.toString()} home office / ${row.sickDays.toString()} sick days, ` +
  `${row.carriedOverDays.toString()} carried over from ${(year - 1).toString()}`;
