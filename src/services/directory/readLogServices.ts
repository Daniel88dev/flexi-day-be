import { and, arrayOverlaps, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { readLog } from "../../db/schema/read-log-schema.js";
import { refuse } from "../../utils/appError.js";
import { personSpellIds } from "../employment/personSpells.js";
import { getPersonContacts } from "../person/personName.js";
import { recordName } from "./recordName.js";
import { administersOrganization, type DirectoryViewer } from "./directoryViewer.js";
import type { ReadLogEntry, ReadLogPage } from "./types.js";

/** Rows older than this go on the nightly tick. Fixed, not configurable. */
export const READ_LOG_RETENTION_MONTHS = 12;

export type ReadLogQuery = {
  employmentId?: string;
  readerUserId?: string;
  before?: string;
  limit: number;
};

const employmentNames = async (organizationId: string, ids: string[], tx?: DbTransaction) => {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await (tx ?? db)
    .select({ id: employments.id, name: recordName(employments, user, organizationId) })
    .from(employments)
    .leftJoin(user, eq(user.id, employments.userId))
    .where(and(eq(employments.organizationId, organizationId), inArray(employments.id, ids)));
  return new Map(rows.map((row) => [row.id, row.name]));
};

const byName = <T extends { name: string | null }>(rows: T[]) =>
  rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

/**
 * One page of the organization's Read log, newest first, with the readers'
 * and people's names, and the people and readers it holds for the filters.
 * Never a value: the rows hold none.
 */
export const listReadLog = async (
  viewer: DirectoryViewer,
  query: ReadLogQuery,
  tx?: DbTransaction
): Promise<ReadLogPage> => {
  const { organizationId } = viewer;
  if (!administersOrganization(viewer)) {
    throw refuse(403, "READ_LOG_DENIED", "Only the owner and org admins read the read log", {
      organizationId,
      viewerUserId: viewer.standing.userId,
    });
  }
  const client = tx ?? db;
  const personSpells = query.employmentId
    ? await personSpellIds(organizationId, { employmentId: query.employmentId }, tx)
    : null;

  const [cursor] = query.before
    ? await client
        .select({ id: readLog.id, createdAt: readLog.createdAt })
        .from(readLog)
        .where(and(eq(readLog.organizationId, organizationId), eq(readLog.id, query.before)))
    : [];

  const rows = await client
    .select()
    .from(readLog)
    .where(
      and(
        eq(readLog.organizationId, organizationId),
        personSpells
          ? arrayOverlaps(readLog.employmentIds, personSpells.length > 0 ? personSpells : [""])
          : undefined,
        query.readerUserId ? eq(readLog.readerUserId, query.readerUserId) : undefined,
        cursor
          ? or(
              lt(readLog.createdAt, cursor.createdAt),
              and(eq(readLog.createdAt, cursor.createdAt), lt(readLog.id, cursor.id))
            )
          : undefined
      )
    )
    .orderBy(desc(readLog.createdAt), desc(readLog.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);

  const everyEmployment = await client
    .selectDistinct({ id: sql<string>`unnest(${readLog.employmentIds})`.as("id") })
    .from(readLog)
    .where(eq(readLog.organizationId, organizationId));
  const everyReader = await client
    .selectDistinct({ id: readLog.readerUserId })
    .from(readLog)
    .where(eq(readLog.organizationId, organizationId));

  const employmentIds = [
    ...new Set([
      ...everyEmployment.map((row) => row.id),
      ...page.flatMap((row) => row.employmentIds),
    ]),
  ];
  const names = await employmentNames(organizationId, employmentIds, tx);
  const userIds = [
    ...new Set([
      ...everyReader.map((row) => row.id),
      ...page.flatMap((row) => (row.subjectUserId ? [row.subjectUserId] : [])),
    ]),
  ];
  const userNames = new Map(
    (await getPersonContacts(userIds, { organizationId }, tx)).map((row) => [row.id, row.name])
  );

  const entries: ReadLogEntry[] = page.map((row) => {
    const employmentId =
      query.employmentId && row.employmentIds.includes(query.employmentId)
        ? query.employmentId
        : (row.employmentIds.find((id) => names.has(id)) ?? row.employmentIds[0] ?? null);
    return {
      id: row.id,
      kind: row.kind,
      at: row.createdAt,
      reader: { userId: row.readerUserId, name: userNames.get(row.readerUserId) ?? null },
      person: {
        employmentId,
        name:
          (employmentId ? names.get(employmentId) : undefined) ??
          (row.subjectUserId ? userNames.get(row.subjectUserId) : undefined) ??
          null,
      },
      sections: row.sections,
      audience: row.audience,
    };
  });

  return {
    entries,
    nextBefore: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    people: byName(
      everyEmployment
        .filter((row) => names.has(row.id))
        .map((row) => ({ employmentId: row.id, name: names.get(row.id)! }))
    ),
    readers: byName(
      everyReader.map((row) => ({ userId: row.id, name: userNames.get(row.id) ?? null }))
    ),
  };
};

/** Removes Read log rows past their 12 months. Safe to run twice. */
export const purgeReadLog = async (now = new Date()): Promise<number> => {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - READ_LOG_RETENTION_MONTHS);
  const removed = await db
    .delete(readLog)
    .where(lt(readLog.createdAt, cutoff))
    .returning({ id: readLog.id });
  return removed.length;
};
