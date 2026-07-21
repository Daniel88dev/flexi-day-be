import { randomBytes } from "node:crypto";
import { db, type DbTransaction } from "../../db/db.js";
import {
  calendarSync,
  calendarSyncTeams,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import type {
  CalendarFeedRecord,
  CalendarSyncFull,
  CalendarSyncInsert,
  CalendarSyncRecord,
  CalendarSyncTypeEntry,
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

/**
 * Creates a config together with its teams and types in a single transaction.
 */
export const createCalendarSync = async (
  base: CalendarSyncInsert,
  teamIds: string[],
  types: CalendarSyncTypeEntry[]
): Promise<CalendarSyncFull> => {
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(calendarSync).values(base).returning();
    if (!row) {
      throw new Error("Failed to create calendar-sync config");
    }
    await writeChildren(row.id, teamIds, types, tx);
    return row;
  });

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
 * Replaces a config's mutable fields and its teams/types. Returns the updated
 * config, or undefined when no live config with that id is owned by the user.
 */
export const updateCalendarSync = async (
  id: string,
  userId: string,
  fields: {
    name: string;
    scope: calendarSyncScope;
    distinguishMine: boolean;
  },
  teamIds: string[],
  types: CalendarSyncTypeEntry[]
): Promise<CalendarSyncFull | undefined> => {
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(calendarSync)
      .set({
        name: fields.name,
        scope: fields.scope,
        distinguishMine: fields.distinguishMine,
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
    await writeChildren(row.id, teamIds, types, tx);
    return row;
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
 * Returns the approved, non-deleted time-off records a config's feed exposes,
 * filtered by its scope, teams and included types, enriched with the owner's
 * display name for the event summary.
 */
export const getFeedRecords = async (config: CalendarSyncFull): Promise<CalendarFeedRecord[]> => {
  const includedTypes = config.types.map((t) => t.vacationType);
  if (includedTypes.length === 0) return [];

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
  ];

  if (config.scope === calendarSyncScope.Me) {
    filters.push(eq(vacation.userId, config.userId));
  } else {
    if (config.teamIds.length === 0) return [];
    filters.push(inArray(vacation.groupId, config.teamIds));
  }

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

  return rows;
};
