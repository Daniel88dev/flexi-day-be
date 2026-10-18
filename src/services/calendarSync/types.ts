import { z } from "zod";
import { calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { timeZoneSchema } from "../calendarConnection/types.js";

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
  connectionId: string | null;
  timeZone: string;
  includeGroupEvents: boolean;
  groupEventsColor: string | null;
  includeBirthdays: boolean;
  birthdaysColor: string | null;
  syncDueAt: Date | null;
  syncAttempts: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** One included calendar record type with its display color(s). */
export type CalendarSyncTypeEntry = {
  vacationType: CalendarRecordType;
  color: string;
  mineColor: string | null;
};

/** A config assembled with its teams and types — the domain object callers use. */
export type CalendarSyncFull = CalendarSyncRecord & {
  teamIds: string[];
  types: CalendarSyncTypeEntry[];
};

/** Zone of a config created without one, and of every config that predates zones. */
export const DEFAULT_CALENDAR_SYNC_TIME_ZONE = "Europe/Prague";

/** Feed settings beyond the record types: the zone and the Group events and Birthdays rows. */
export type CalendarSyncSettings = Pick<
  CalendarSyncRecord,
  "timeZone" | "includeGroupEvents" | "groupEventsColor" | "includeBirthdays" | "birthdaysColor"
>;

export type CalendarSyncInsert = Pick<
  CalendarSyncRecord,
  "id" | "userId" | "name" | "scope" | "distinguishMine" | "token"
> &
  Partial<CalendarSyncSettings>;

/**
 * A time-off record as it appears in a feed, enriched with the owner's display
 * name for the event summary.
 */
export type VacationFeedRecord = {
  kind: "vacation";
  id: string;
  userId: string;
  userName: string;
  groupId: string;
  vacationType: CalendarRecordType;
  requestedDay: string;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
};

/** A birthday as a yearly all-day series. Never carries the year, so no age leaves Flexi Day. */
export type BirthdayFeedRecord = {
  kind: "birthday";
  userId: string;
  userName: string;
  month: number;
  day: number;
  /** The first occurrence on or after the row's `createdAt`, so the series never moves. */
  startDate: string;
};

/** One entry per source a feed or a sync target carries. */
export type CalendarFeedRecord = VacationFeedRecord | BirthdayFeedRecord;

const typeEntrySchema = z.object({
  type: z.enum(CalendarRecordType),
  color: z.enum(CALENDAR_SYNC_PALETTE),
  mineColor: z.enum(CALENDAR_SYNC_PALETTE).optional(),
});

const paletteColor = z.enum(CALENDAR_SYNC_PALETTE).nullable();

const configShape = {
  name: z.string().trim().min(1).max(120),
  scope: z.enum(calendarSyncScope).default(calendarSyncScope.Me),
  distinguishMine: z.boolean().default(false),
  teamIds: z.array(z.uuid()).default([]),
  types: z.array(typeEntrySchema),
};

type ConfigShape = z.output<z.ZodObject<typeof configShape>> & { includeBirthdays?: boolean };

/** Every source a feed can carry; one of them has to be on. */
const carriesSomething = (data: ConfigShape) =>
  data.types.length > 0 || data.includeBirthdays === true;

const withConfigRules = <T extends z.ZodType<ConfigShape>>(schema: T) =>
  schema
    .refine(carriesSomething, {
      message: "Include at least one record type or Birthdays",
      path: ["types"],
    })
    .refine((data) => data.scope !== calendarSyncScope.Team || data.teamIds.length > 0, {
      message: "At least one team is required for team scope",
      path: ["teamIds"],
    })
    .refine((data) => new Set(data.types.map((t) => t.type)).size === data.types.length, {
      message: "Duplicate record types are not allowed",
      path: ["types"],
    });

/**
 * Body for creating a calendar-sync config. `teamIds` is required for `TEAM`
 * scope and ignored (but stored) for `ME`. It carries at least one record type,
 * or Birthdays.
 */
export const validateCreateCalendarSync = withConfigRules(
  z.object({
    ...configShape,
    timeZone: timeZoneSchema.default(DEFAULT_CALENDAR_SYNC_TIME_ZONE),
    includeGroupEvents: z.boolean().default(false),
    groupEventsColor: paletteColor.default(null),
    includeBirthdays: z.boolean().default(false),
    birthdaysColor: paletteColor.default(null),
  })
);

export type ValidatedCreateCalendarSync = z.infer<typeof validateCreateCalendarSync>;

/**
 * Update replaces the name, scope, teams and types. The zone and the Group
 * events and Birthdays settings change only when the body names them, so a
 * client that predates them leaves them as they are.
 */
export const validateUpdateCalendarSync = withConfigRules(
  z.object({
    ...configShape,
    timeZone: timeZoneSchema.optional(),
    includeGroupEvents: z.boolean().optional(),
    groupEventsColor: paletteColor.optional(),
    includeBirthdays: z.boolean().optional(),
    birthdaysColor: paletteColor.optional(),
  })
);
export type ValidatedUpdateCalendarSync = z.infer<typeof validateUpdateCalendarSync>;

export type SyncOutcome =
  | { status: "done" }
  /** `attempts` is the target's failure count after this one. */
  | { status: "retry"; attempts: number }
  /** The provider asked to slow down; not a failed attempt. */
  | { status: "throttled"; retryAfterSeconds: number | null }
  /** Another instance holds the connection's lease. */
  | { status: "busy" };

export type SyncQueueTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type DirtyRow = {
  userId: string;
  vacationType: CalendarRecordType;
  approvedAt: Date | null;
};
