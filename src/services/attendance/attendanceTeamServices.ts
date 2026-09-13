import type { DbTransaction } from "../../db/db.js";
import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
import {
  businessDateInZone,
  expandDateRangeInclusive,
  type DateString,
} from "../../utils/dateFunc.js";
import { resolveTeamAudience } from "../employment/attendanceAccess.js";
import { listEmployments } from "../employment/employmentServices.js";
import { getActiveGroupsForUsersInOrganization } from "../groupUser/groupUserServices.js";
import { getAttendanceSettings } from "../organization/attendanceSettingsServices.js";
import { computeAttendance, type DayExclusion } from "./attendanceCalculation.js";
import { getAttendanceExclusionsForPeople } from "./attendanceExclusions.js";
import {
  listOpenSessionsForEmployments,
  listSessionsForEmploymentsInRange,
} from "./attendanceServices.js";
import {
  AttendanceTeamScope,
  type AttendanceTeamType,
  type ValidatedAttendanceTeamQueryType,
} from "./types.js";

/**
 * The team dashboard, scoped by `resolveTeamAudience` and figured by the same
 * computation as the month view, so what an admin reads and what the person
 * reads cannot drift apart. Never gated by the plan.
 */
export const getTeamAttendance = async (
  viewerUserId: string,
  query: ValidatedAttendanceTeamQueryType,
  tx?: DbTransaction
): Promise<AttendanceTeamType> => {
  const { organizationId, from, to } = query;
  const audience = await resolveTeamAudience(viewerUserId, organizationId, query.groupId, tx);
  const settings = {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    ...(await getAttendanceSettings(organizationId, tx)),
  };

  const employments = await listEmployments(
    organizationId,
    { userIds: audience.userIds, active: true },
    tx
  );
  const userIds = employments.map((employment) => employment.userId);
  const employmentIds = employments.map((employment) => employment.id);

  const groupsByUser = await getActiveGroupsForUsersInOrganization(organizationId, userIds, tx);
  const sessions = await listSessionsForEmploymentsInRange(employmentIds, from, to, tx);
  const open = await listOpenSessionsForEmployments(employmentIds, tx);

  const now = new Date();
  // No zone means no session could ever have been recorded, so UTC decides only
  // which of an empty range's days are still to come.
  const timezone = settings.timezone ?? "UTC";
  const dates = expandDateRangeInclusive(from, to);
  const exclusionsByUser = await getAttendanceExclusionsForPeople(
    {
      organizationId,
      people: employments.map((employment) => ({
        userId: employment.userId,
        employment,
      })),
      dates,
      rules: { workingDays: settings.workingDays, holidayCountry: settings.holidayCountry },
      timezone,
    },
    tx
  );

  const people = employments.map((employment) => {
    const { days, totals } = computeAttendance({
      dates,
      sessions: sessions.filter((session) => session.employmentId === employment.id),
      rules: {
        breakMinutes: settings.breakMinutes,
        breakThresholdMinutes: settings.breakThresholdMinutes,
        requiredMinutesPerDay: settings.requiredMinutesPerDay,
        requiredMinutesOverride: employment.requiredMinutesPerDay,
        balanceMode: settings.balanceMode,
      },
      exclusions: exclusionsByUser.get(employment.userId) ?? new Map<DateString, DayExclusion>(),
      timezone,
      now,
    });

    return {
      employmentId: employment.id,
      userId: employment.userId,
      user: employment.user,
      groups: groupsByUser.get(employment.userId) ?? [],
      requiredMinutesPerDay: employment.requiredMinutesPerDay ?? settings.requiredMinutesPerDay,
      requiredMinutesOverride: employment.requiredMinutesPerDay,
      days,
      totals,
    };
  });

  const userIdOfEmployment = new Map(
    employments.map((employment) => [employment.id, employment.userId])
  );
  const inNow = open.flatMap(({ session, openBreak }) => {
    const userId = userIdOfEmployment.get(session.employmentId);
    if (userId === undefined) return [];
    return [
      {
        employmentId: session.employmentId,
        userId,
        sessionId: session.id,
        businessDate: session.businessDate,
        startedAt: session.startedAt,
        onBreak: openBreak !== null,
        breakStartedAt: openBreak?.startedAt ?? null,
      },
    ];
  });

  return {
    organizationId,
    timezone: settings.timezone,
    businessDate: settings.timezone ? businessDateInZone(now, settings.timezone) : null,
    from,
    to,
    balanceMode: settings.balanceMode,
    requiredMinutesPerDay: settings.requiredMinutesPerDay,
    breakMinutes: settings.breakMinutes,
    breakThresholdMinutes: settings.breakThresholdMinutes,
    scope: audience.everyone ? AttendanceTeamScope.Organization : AttendanceTeamScope.Groups,
    group: audience.group,
    people,
    inNow,
  };
};
