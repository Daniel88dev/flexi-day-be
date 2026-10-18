import { randomBytes } from "node:crypto";
import { db, type DbTransaction } from "../../db/db.js";
import {
  calendarSync,
  calendarSyncTeams,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { teamScopeError } from "../calendarConnection/errors.js";
import { calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import { getBirthday } from "../birthday/birthdayServices.js";
import { liveBirthday, sharedBirthdaysInGroups } from "../birthday/birthdayVisibility.js";
import { firstBirthdayOnOrAfter } from "../birthday/birthdayOccurrence.js";
import type { Birthday } from "../birthday/types.js";
import { getUsersByIds } from "../user/userServices.js";
import type {
  BirthdayFeedRecord,
  CalendarFeedRecord,
  CalendarSyncFull,
  CalendarSyncInsert,
  CalendarSyncRecord,
  CalendarSyncSettings,
  CalendarSyncTypeEntry,
  VacationFeedRecord,
} from "./types.js";

/**
 * Generates a new secret feed token. Format mirrors the front-end mock:
 * `flx_live_` followed by 40 hex characters.
 */
export const generateFeedToken = (): string => `flx_live_${randomBytes(20).toString("hex")}`;

/** Assembles base rows + their teams + types into full domain objects. */
const assembleConfigs = async (rows: CalendarSyncRecord[]): Promise<CalendarSyncFull[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [teamRows, typeRows] = await Promise.all([
    db.select().from(calendarSyncTeams).where(inArray(calendarSyncTeams.calendarSyncId, ids)),
    db.select().from(calendarSyncTypes).where(inArray(calendarSyncTypes.calendarSyncId, ids)),
  ]);

  const teamsById = new Map<string, string[]>();
  for (const t of teamRows) {
    const list = teamsById.get(t.calendarSyncId) ?? [];
    list.push(t.groupId);
    teamsById.set(t.calendarSyncId, list);
  }

  const typesById = new Map<string, CalendarSyncTypeEntry[]>();
  for (const t of typeRows) {
    const list = typesById.get(t.calendarSyncId) ?? [];
    list.push({
      vacationType: t.vacationType,
      color: t.color,
      mineColor: t.mineColor,
    });
    typesById.set(t.calendarSyncId, list);
  }

  return rows.map((r) => ({
    ...r,
    teamIds: teamsById.get(r.id) ?? [],
    types: typesById.get(r.id) ?? [],
  }));
};

/** Replaces the teams + types child rows for a config (used by create/update). */
const writeChildren = async (
  calendarSyncId: string,
  teamIds: string[],
  types: CalendarSyncTypeEntry[],
  tx: DbTransaction
): Promise<void> => {
  await tx.delete(calendarSyncTeams).where(eq(calendarSyncTeams.calendarSyncId, calendarSyncId));
  await tx.delete(calendarSyncTypes).where(eq(calendarSyncTypes.calendarSyncId, calendarSyncId));

  // De-dupe teamIds defensively; the unique index would otherwise reject.
  const uniqueTeamIds = [...new Set(teamIds)];
  if (uniqueTeamIds.length > 0) {
    await tx.insert(calendarSyncTeams).values(
      uniqueTeamIds.map((groupId) => ({
        id: generateRandomUUID(),
        calendarSyncId,
        groupId,
      }))
    );
  }

  if (types.length > 0) {
    await tx.insert(calendarSyncTypes).values(
      types.map((t) => ({
        id: generateRandomUUID(),
        calendarSyncId,
        vacationType: t.vacationType,
        color: t.color,
        mineColor: t.mineColor ?? null,
      }))
    );
  }
};

/** Writes a config with its teams and types inside the caller's transaction. */
export const insertCalendarSync = async (
  base: CalendarSyncInsert,
  teamIds: string[],
  types: CalendarSyncTypeEntry[],
  tx: DbTransaction
) => {
  const [row] = await tx.insert(calendarSync).values(base).returning();
  if (!row) {
    throw new Error("Failed to create calendar-sync config");
  }
  await writeChildren(row.id, teamIds, types, tx);
  return row;
};

/**
 * Creates a config together with its teams and types in a single transaction.
 */
export const createCalendarSync = async (
  base: CalendarSyncInsert,
  teamIds: string[],
  types: CalendarSyncTypeEntry[]
): Promise<CalendarSyncFull> => {
  const created = await db.transaction((tx) => insertCalendarSync(base, teamIds, types, tx));

  const [full] = await assembleConfigs([created]);
  if (!full) {
    throw new Error("Failed to assemble created calendar-sync config");
  }
  return full;
};

/** Lists the caller's live configs, newest first, assembled with children. */
export const getCalendarSyncForUser = async (userId: string): Promise<CalendarSyncFull[]> => {
  const rows = await db
    .select()
    .from(calendarSync)
    .where(and(eq(calendarSync.userId, userId), isNull(calendarSync.deletedAt)))
    .orderBy(desc(calendarSync.createdAt));

  return assembleConfigs(rows);
};

/** Fetches a single live config owned by the caller, assembled with children. */
export const getCalendarSyncById = async (
  id: string,
  userId: string
): Promise<CalendarSyncFull | undefined> => {
  const [row] = await db
    .select()
    .from(calendarSync)
    .where(
      and(eq(calendarSync.id, id), eq(calendarSync.userId, userId), isNull(calendarSync.deletedAt))
    );
  if (!row) return undefined;
  const [full] = await assembleConfigs([row]);
  return full;
};

/**
 * Resolves a live config by its secret feed token. No ownership filter — this
 * powers the public feed endpoint, where the token itself is the credential.
 */
export const getCalendarSyncByToken = async (
  token: string
): Promise<CalendarSyncFull | undefined> => {
  const [row] = await db
    .select()
    .from(calendarSync)
    .where(and(eq(calendarSync.token, token), isNull(calendarSync.deletedAt)));
  if (!row) return undefined;
  const [full] = await assembleConfigs([row]);
  return full;
};

/**
 * Replaces a config's mutable fields and its teams/types. Settings left
 * undefined keep their stored value. Returns the updated config, or undefined
 * when no live config with that id is owned by the user. A sync target whose
 * type list, zone or Birthdays row changed comes back marked due.
 */
export const updateCalendarSync = async (
  id: string,
  userId: string,
  fields: {
    name: string;
    scope: calendarSyncScope;
    distinguishMine: boolean;
  } & Partial<CalendarSyncSettings>,
  teamIds: string[],
  types: CalendarSyncTypeEntry[]
): Promise<CalendarSyncFull | undefined> => {
  const { timeZone, includeBirthdays } = fields;
  // Column references on the right of SET read the row as it was before this update.
  const moved = [
    timeZone === undefined ? undefined : sql`${calendarSync.timeZone} <> ${timeZone}`,
    includeBirthdays === undefined
      ? undefined
      : sql`${calendarSync.includeBirthdays} <> ${includeBirthdays}`,
  ].filter((change) => change !== undefined);
  const settingsMoved =
    moved.length === 0
      ? undefined
      : sql`${calendarSync.connectionId} IS NOT NULL AND (${sql.join(moved, sql` OR `)})`;
  const updated = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .update(calendarSync)
        .set({
          name: fields.name,
          scope: fields.scope,
          distinguishMine: fields.distinguishMine,
          timeZone,
          includeGroupEvents: fields.includeGroupEvents,
          groupEventsColor: fields.groupEventsColor,
          includeBirthdays: fields.includeBirthdays,
          birthdaysColor: fields.birthdaysColor,
          ...(settingsMoved
            ? {
                syncDueAt: sql`CASE WHEN ${settingsMoved} THEN now() ELSE ${calendarSync.syncDueAt} END`,
                syncAttempts: sql`CASE WHEN ${settingsMoved} THEN 0 ELSE ${calendarSync.syncAttempts} END`,
              }
            : {}),
        })
        .where(
          and(
            eq(calendarSync.id, id),
            eq(calendarSync.userId, userId),
            isNull(calendarSync.deletedAt)
          )
        )
        .returning();
      if (!row) return undefined;
      const before = await tx
        .select({ vacationType: calendarSyncTypes.vacationType })
        .from(calendarSyncTypes)
        .where(eq(calendarSyncTypes.calendarSyncId, row.id));
      await writeChildren(row.id, teamIds, types, tx);

      const after = new Set(types.map((t) => t.vacationType));
      const typesChanged =
        before.length !== after.size || before.some((t) => !after.has(t.vacationType));
      if (!row.connectionId || !typesChanged) return row;
      const [due] = await tx
        .update(calendarSync)
        .set({ syncDueAt: new Date(), syncAttempts: 0 })
        .where(eq(calendarSync.id, row.id))
        .returning();
      return due ?? row;
    })
    .catch((error: unknown) => {
      // A config syncing to a connected account cannot become TEAM; turn the target off first.
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === "23514" && cause.constraint === "calendar_sync_target_me_scope_chk") {
        throw teamScopeError({ configId: id, userId });
      }
      throw error;
    });

  if (!updated) return undefined;
  const [full] = await assembleConfigs([updated]);
  return full;
};

/** Soft-deletes a config. Returns the row when something was deleted. */
export const softDeleteCalendarSync = async (
  id: string,
  userId: string
): Promise<CalendarSyncRecord | undefined> => {
  const [row] = await db
    .update(calendarSync)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(calendarSync.id, id), eq(calendarSync.userId, userId), isNull(calendarSync.deletedAt))
    )
    .returning();
  return row;
};

/**
 * Rotates the feed token, revoking the old link. Returns the updated config
 * (with the fresh token) or undefined when the config was not found.
 */
export const regenerateToken = async (
  id: string,
  userId: string,
  newToken: string
): Promise<CalendarSyncFull | undefined> => {
  const [row] = await db
    .update(calendarSync)
    .set({ token: newToken })
    .where(
      and(eq(calendarSync.id, id), eq(calendarSync.userId, userId), isNull(calendarSync.deletedAt))
    )
    .returning();
  if (!row) return undefined;
  const [full] = await assembleConfigs([row]);
  return full;
};

/** Records that a feed was fetched — surfaced as "last fetched" in the UI. */
export const touchLastFetched = async (id: string): Promise<void> => {
  await db.update(calendarSync).set({ lastFetchedAt: new Date() }).where(eq(calendarSync.id, id));
};

/**
 * The stored team ids of a `TEAM` config that its owner is still a live member
 * of. Every record kind a team feed carries filters by this, not by the stored
 * rows, which stay untouched so a re-join restores the group.
 */
export const getLiveTeamIds = async (config: CalendarSyncFull): Promise<string[]> => {
  if (config.teamIds.length === 0) return [];
  const rows = await db
    .select({ groupId: groupUsers.groupId })
    .from(groupUsers)
    .where(
      and(
        eq(groupUsers.userId, config.userId),
        inArray(groupUsers.groupId, config.teamIds),
        isNull(groupUsers.deletedAt)
      )
    );
  return rows.map((r) => r.groupId);
};

/** The groups a feed reads from: null on a personal feed, the live selected groups on a team feed. */
type FeedGroups = string[] | null;

/**
 * The approved, non-deleted time-off records in the feed's window, of the
 * owner on a personal feed or of the live selected groups on a team feed.
 */
const vacationRecords = async (
  config: CalendarSyncFull,
  groupIds: FeedGroups
): Promise<VacationFeedRecord[]> => {
  const includedTypes = config.types.map((t) => t.vacationType);
  if (includedTypes.length === 0 || groupIds?.length === 0) return [];

  // Bound the feed to a rolling window so both the query cost and the generated
  // .ics size stay constant as approved history accumulates. All future dates
  // plus the last 12 months of history are exposed.
  const windowStart = new Date();
  windowStart.setUTCMonth(windowStart.getUTCMonth() - 12);
  const windowStartDay = windowStart.toISOString().slice(0, 10);

  const filters = [
    isNull(vacation.deletedAt),
    isNull(vacation.rejectedAt),
    isNotNull(vacation.approvedAt),
    inArray(vacation.vacationType, includedTypes),
    gte(vacation.requestedDay, windowStartDay),
    groupIds === null ? eq(vacation.userId, config.userId) : inArray(vacation.groupId, groupIds),
  ];

  const rows = await db
    .select({
      id: vacation.id,
      userId: vacation.userId,
      userName: user.name,
      groupId: vacation.groupId,
      vacationType: vacation.vacationType,
      requestedDay: vacation.requestedDay,
      startTime: vacation.startTime,
      endTime: vacation.endTime,
      note: vacation.note,
    })
    .from(vacation)
    .innerJoin(user, eq(vacation.userId, user.id))
    .where(and(...filters))
    .orderBy(vacation.requestedDay);

  return rows.map((row) => ({ kind: "vacation", ...row }));
};

/**
 * Birthdays as yearly series: the owner's own on a personal feed and on direct
 * sync, never a colleague's; on a team feed the shared birthdays of the live
 * selected groups' members, each person once.
 */
const birthdayRecords = async (
  config: CalendarSyncFull,
  groupIds: FeedGroups
): Promise<BirthdayFeedRecord[]> => {
  if (!config.includeBirthdays) return [];
  const birthdays =
    groupIds === null
      ? [liveBirthday(await getBirthday(config.userId))].filter((b): b is Birthday => b !== null)
      : await sharedBirthdaysInGroups(config.userId, groupIds);
  if (birthdays.length === 0) return [];

  const names = await getUsersByIds(birthdays.map((b) => b.userId));
  const nameOf = new Map(names.map((row) => [row.id, row.name]));
  return birthdays
    .map((b) => ({
      kind: "birthday" as const,
      userId: b.userId,
      userName: nameOf.get(b.userId) ?? "",
      month: b.month,
      day: b.day,
      startDate: firstBirthdayOnOrAfter(b, b.createdAt.toISOString().slice(0, 10)),
    }))
    .sort((a, b) => a.userName.localeCompare(b.userName) || a.userId.localeCompare(b.userId));
};

/**
 * Everything a config's feed and sync target carry, one source per record
 * kind, each filtered by the config's toggles. A team feed reads only the
 * selected groups its owner is still in.
 */
export const getFeedRecords = async (config: CalendarSyncFull): Promise<CalendarFeedRecord[]> => {
  const groupIds = config.scope === calendarSyncScope.Me ? null : await getLiveTeamIds(config);
  const [vacations, birthdays] = await Promise.all([
    vacationRecords(config, groupIds),
    birthdayRecords(config, groupIds),
  ]);
  return [...vacations, ...birthdays];
};
