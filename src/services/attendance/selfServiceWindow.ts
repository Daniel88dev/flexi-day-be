import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";

/** The organization's self-service window: off, N days back, or no limit (`days: null`). */
export type SelfServiceWindow = { enabled: boolean; days: number | null };

export type SelfServiceRefusal = "EMPLOYMENT_ENDED" | "SELF_SERVICE_OFF" | "SELF_SERVICE_WINDOW";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window as stored, or the defaults for an organization that never saved its settings. */
export const selfServiceWindowOf = ({
  selfServiceEnabled,
  selfServiceDays,
}: {
  selfServiceEnabled: boolean;
  selfServiceDays: number | null;
} = ATTENDANCE_SETTINGS_DEFAULTS): SelfServiceWindow => ({
  enabled: selfServiceEnabled,
  days: selfServiceDays,
});

const daysBetween = (from: DateString, to: DateString): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Why the person themselves may not change this session, or null when they
 * may (`docs/attendance.md`, "Self-service window"). Admin rights never come
 * through here.
 */
export const selfServiceRefusal = ({
  session,
  window,
  employmentEnded,
  timezone,
  now,
}: {
  session: { endedAt: Date | null; businessDate: DateString };
  window: SelfServiceWindow;
  employmentEnded: boolean;
  timezone: string;
  now: Date;
}): SelfServiceRefusal | null => {
  if (employmentEnded) return "EMPLOYMENT_ENDED";
  if (!window.enabled) return "SELF_SERVICE_OFF";
  if (session.endedAt === null || window.days === null) return null;

  const back = daysBetween(session.businessDate, businessDateInZone(now, timezone));
  return back >= 0 && back <= window.days ? null : "SELF_SERVICE_WINDOW";
};
