import { z } from "zod";
import {
  calendarCapability,
  calendarConnection,
  calendarConnectionStatus,
  calendarProvider,
  calendarSyncEvents,
} from "../../db/schema/calendar-connection-schema.js";

/** `publicContext.code` when a direct-sync target is asked of a `TEAM` config. */
export const CALENDAR_SYNC_TEAM_SCOPE = "CALENDAR_SYNC_TEAM_SCOPE";

export type CalendarConnectionRecord = typeof calendarConnection.$inferSelect;
export type CalendarConnectionInsert = typeof calendarConnection.$inferInsert;
export type CalendarSyncEventRecord = typeof calendarSyncEvents.$inferSelect;
export type CalendarSyncEventInsert = typeof calendarSyncEvents.$inferInsert;

export const validateCalendarProviderParam = z
  .enum(["google", "microsoft"])
  .transform((value) =>
    value === "google" ? calendarProvider.Google : calendarProvider.Microsoft
  );

const IANA_TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

// Intl also accepts offsets such as "+01:00", which neither Google nor Graph takes.
const ianaTimeZone = (value: string): string | undefined => {
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return IANA_TIME_ZONES.has(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
};

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => ianaTimeZone(value) !== undefined, { message: "Unknown time zone" })
  .transform((value) => ianaTimeZone(value) as string);

/** Body of `POST /api/calendar-sync/connections/:provider/start`. */
export const validateStartCalendarConnection = z.object({
  configId: z.uuid(),
  timeZone: timeZoneSchema,
});
export type ValidatedStartCalendarConnection = z.infer<typeof validateStartCalendarConnection>;

/** Body of `PUT /api/calendar-sync/:id/target`. */
export const validateUpdateCalendarTarget = z.object({
  timeZone: timeZoneSchema,
});
export type ValidatedUpdateCalendarTarget = z.infer<typeof validateUpdateCalendarTarget>;

export type AttachTargetInput = {
  configId: string;
  userId: string;
  connectionId: string;
  timeZone: string;
};

/** A connection as the API returns it. Never carries a token. */
export type CalendarConnectionView = {
  provider: calendarProvider;
  status: calendarConnectionStatus;
  capability: calendarCapability;
  createdAt: string;
};

/** A target whose owner's plan lapsed: no writes, nothing deleted. */
export const CALENDAR_TARGET_PAUSED = "PAUSED" as const;

export type CalendarTargetStatus = calendarConnectionStatus | typeof CALENDAR_TARGET_PAUSED;

/** The `target` object on a calendar-sync config, or `null` when direct sync is off. */
export type CalendarTargetView = {
  provider: calendarProvider;
  status: CalendarTargetStatus;
  capability: calendarCapability;
  timeZone: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncing: boolean;
};
