import type { Request } from "express";
import { vacationType } from "../../db/schema/vacation-schema.js";
import type {
  CalendarSyncFull,
  ValidatedCreateCalendarSync,
} from "../../services/calendarSync/types.js";
import { calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";

/** Human-readable labels for each leave type, used in feed event summaries. */
export const VACATION_TYPE_LABELS: Record<vacationType, string> = {
  [vacationType.Vacation]: "Vacation",
  [vacationType.HomeOffice]: "Home office",
  [vacationType.Sick]: "Sick",
  [vacationType.BankHoliday]: "Bank holiday",
  [vacationType.NonPaidLeave]: "Non-paid leave",
  [vacationType.PaidTimeOff]: "Paid time off",
  [vacationType.SickLeave]: "Sick leave",
  [vacationType.StudyLeave]: "Study leave",
  [vacationType.Other]: "Other",
};

/**
 * Public base URL used to build feed links. Prefers `FEED_BASE_URL`, otherwise
 * derives it from the incoming request (works behind the configured proxy).
 */
export const feedBaseUrl = (req: Request): string => {
  const configured = process.env.FEED_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
};

/** The public subscription URL for a token. */
export const feedUrl = (baseUrl: string, token: string): string =>
  `${baseUrl}/calendars/${token}.ics`;

/** Masks a token for list responses so the secret is never fully echoed. */
export const maskToken = (token: string): string =>
  `${token.slice(0, 9)}${"•".repeat(18)}`;

/**
 * Shapes a config for API responses. `revealToken` controls whether the full
 * feed URL is returned (create / regenerate / detail) or a masked one (list).
 */
export const serializeConfig = (
  config: CalendarSyncFull,
  baseUrl: string,
  revealToken: boolean
) => ({
  id: config.id,
  name: config.name,
  scope: config.scope,
  distinguishMine: config.distinguishMine,
  teamIds: config.teamIds,
  types: config.types.map((t) => ({
    type: t.vacationType,
    label: VACATION_TYPE_LABELS[t.vacationType],
    color: t.color,
    mineColor: t.mineColor,
  })),
  feedUrl: revealToken
    ? feedUrl(baseUrl, config.token)
    : feedUrl(baseUrl, maskToken(config.token)),
  tokenMasked: !revealToken,
  lastFetchedAt: config.lastFetchedAt
    ? config.lastFetchedAt.toISOString()
    : null,
  createdAt: config.createdAt.toISOString(),
  updatedAt: config.updatedAt.toISOString(),
});

/**
 * Validates that every requested team belongs to the user. Returns the list of
 * team ids to persist: for `ME` scope teams are ignored (empty), for `TEAM`
 * scope any team the user is not a member of is rejected by returning null.
 */
export const resolveTeamIds = (
  data: ValidatedCreateCalendarSync,
  userGroupIds: Set<string>
): string[] | null => {
  if (data.scope === calendarSyncScope.Me) return [];
  for (const id of data.teamIds) {
    if (!userGroupIds.has(id)) return null;
  }
  return [...new Set(data.teamIds)];
};
