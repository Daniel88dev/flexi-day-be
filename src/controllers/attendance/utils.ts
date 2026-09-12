import type { Request } from "express";
import {
  validateAttendanceScope,
  type AttendanceBreakType,
  type AttendanceSessionView,
  type AttendanceMonthType,
  type AttendanceStateType,
  type ValidatedAttendanceScopeType,
} from "../../services/attendance/types.js";

/** The state read has no body, so its organization travels in the query string. */
export const attendanceScopeOfQuery = (req: Request): string | undefined =>
  validateAttendanceScope.parse(req.query).organizationId;

/** The writes have one, already parsed by `bodyValidationMiddleware`. */
export const attendanceScopeOfBody = (req: Request): string | undefined =>
  (req.body as ValidatedAttendanceScopeType).organizationId;

export const presentBreak = (entry: AttendanceBreakType) => ({
  id: entry.id,
  sessionId: entry.sessionId,
  startedAt: entry.startedAt,
  endedAt: entry.endedAt,
  autoClosed: entry.autoClosed,
  open: entry.endedAt === null,
});

export const presentSession = (session: AttendanceSessionView) => ({
  id: session.id,
  businessDate: session.businessDate,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  timezone: session.timezone,
  closedBy: session.closedBy,
  open: session.endedAt === null,
  startLatitude: session.startLatitude,
  startLongitude: session.startLongitude,
  startAccuracy: session.startAccuracy,
  endLatitude: session.endLatitude,
  endLongitude: session.endLongitude,
  endAccuracy: session.endAccuracy,
  breaks: session.breaks.map(presentBreak),
});

export const presentAttendanceState = (state: AttendanceStateType) => ({
  organizationId: state.organizationId,
  employmentId: state.employmentId,
  employmentEnded: state.employmentEnded,
  active: state.active,
  locationEnabled: state.locationEnabled,
  timezone: state.timezone,
  businessDate: state.businessDate,
  openSession: state.openSession ? presentSession(state.openSession) : null,
  openBreak: state.openBreak ? presentBreak(state.openBreak) : null,
  sessions: state.sessions.map(presentSession),
  autoClosedSession: state.autoClosedSession ? presentSession(state.autoClosedSession) : null,
});

export const presentAttendanceMonth = (month: AttendanceMonthType) => ({
  organizationId: month.organizationId,
  employmentId: month.employmentId,
  timezone: month.timezone,
  businessDate: month.businessDate,
  year: month.year,
  month: month.month,
  balanceMode: month.balanceMode,
  requiredMinutesPerDay: month.requiredMinutesPerDay,
  requiredMinutesOverride: month.requiredMinutesOverride,
  breakMinutes: month.breakMinutes,
  breakThresholdMinutes: month.breakThresholdMinutes,
  days: month.days.map((day) => ({
    businessDate: day.businessDate,
    presenceMinutes: day.presenceMinutes,
    breaksMinutes: day.breaksMinutes,
    deductedMinutes: day.deductedMinutes,
    workedMinutes: day.workedMinutes,
    requiredMinutes: day.requiredMinutes,
    balanceMinutes: day.balanceMinutes,
    upcoming: day.upcoming,
    open: day.open,
    autoClosed: day.autoClosed,
    flagged: day.flagged,
    sessions: day.sessions.map(presentSession),
  })),
  totals: month.totals,
});
