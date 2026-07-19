import { z } from "zod";
import { calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import { vacationType } from "../../db/schema/vacation-schema.js";

/**
 * Swatch palette keys shared with the front-end builder. Colors are stored as
 * these stable keys (not raw CSS) so the palette can be re-themed client-side.
 */
export const CALENDAR_SYNC_PALETTE = [
  "violet",
  "indigo",
  "blue",
  "teal",
  "green",
  "amber",
  "coral",
  "rose",
  "plum",
  "slate",
] as const;

export type CalendarSyncColor = (typeof CALENDAR_SYNC_PALETTE)[number];

/** Base row of the `calendar_sync` config table. */
export type CalendarSyncRecord = {
  id: string;
  userId: string;
  name: string;
  scope: calendarSyncScope;
  distinguishMine: boolean;
  token: string;
  lastFetchedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** One included leave type with its display color(s). */
export type CalendarSyncTypeEntry = {
  vacationType: vacationType;
  color: string;
  mineColor: string | null;
};

/** A config assembled with its teams and types — the domain object callers use. */
export type CalendarSyncFull = CalendarSyncRecord & {
  teamIds: string[];
  types: CalendarSyncTypeEntry[];
};

export type CalendarSyncInsert = Pick<
  CalendarSyncRecord,
  "id" | "userId" | "name" | "scope" | "distinguishMine" | "token"
>;

/**
 * A time-off record as it appears in a feed, enriched with the owner's display
 * name for the event summary.
 */
export type CalendarFeedRecord = {
  id: string;
  userId: string;
  userName: string;
  groupId: string;
  vacationType: vacationType;
  requestedDay: string;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
};

const typeEntrySchema = z.object({
  type: z.enum(vacationType),
  color: z.enum(CALENDAR_SYNC_PALETTE),
  mineColor: z.enum(CALENDAR_SYNC_PALETTE).optional(),
});

/**
 * Body for creating a calendar-sync config. `teamIds` is required for `TEAM`
 * scope and ignored (but stored) for `ME`. At least one type must be included.
 */
export const validateCreateCalendarSync = z
  .object({
    name: z.string().trim().min(1).max(120),
    scope: z.enum(calendarSyncScope).default(calendarSyncScope.Me),
    distinguishMine: z.boolean().default(false),
    teamIds: z.array(z.uuid()).default([]),
    types: z.array(typeEntrySchema).min(1),
  })
  .refine(
    (data) =>
      data.scope !== calendarSyncScope.Team || data.teamIds.length > 0,
    { message: "At least one team is required for team scope", path: ["teamIds"] }
  )
  .refine(
    (data) =>
      new Set(data.types.map((t) => t.type)).size === data.types.length,
    { message: "Duplicate record types are not allowed", path: ["types"] }
  );

export type ValidatedCreateCalendarSync = z.infer<
  typeof validateCreateCalendarSync
>;

/** Update accepts the same shape as create; the whole config is replaced. */
export const validateUpdateCalendarSync = validateCreateCalendarSync;
export type ValidatedUpdateCalendarSync = ValidatedCreateCalendarSync;
