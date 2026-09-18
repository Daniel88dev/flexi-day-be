import type { SyncPage, SyncPagePosition, SyncTableName, SyncTableReader } from "./types.js";

/** Fixed server-side: the endpoint takes no `limit`, so one page is one page everywhere. */
export const SYNC_PAGE_SIZE = 1000;

export const SYNC_TABLE_ORDER: readonly SyncTableName[] = [
  "organizations",
  "users",
  "groups",
  "groupUsers",
  "groupMirrors",
  "userYearQuotas",
  "bankHolidays",
  "vacations",
];

/**
 * Fills one page by walking the tables in dependency order, resuming where the
 * last page stopped. A reader is asked for one row more than the page has room
 * for: that extra row is what says the table still holds rows, so a page that
 * ends flush with a table boundary still reports the page after it. Tables
 * before the one being resumed in are not read at all, and a table with no
 * reader is empty.
 */
export const collectSyncPage = async (
  readers: SyncTableReader[],
  resume: SyncPagePosition | null,
  pageSize: number = SYNC_PAGE_SIZE
): Promise<SyncPage> => {
  const rows = new Map<SyncTableName, unknown[]>(SYNC_TABLE_ORDER.map((table) => [table, []]));
  const resumeIndex = resume === null ? -1 : SYNC_TABLE_ORDER.indexOf(resume.table);
  const startIndex = resumeIndex === -1 ? 0 : resumeIndex;
  const resumeAfter = resume?.after ?? null;
  let remaining = pageSize;

  for (const [index, table] of SYNC_TABLE_ORDER.entries()) {
    if (index < startIndex) continue;

    const reader = readers.find((candidate) => candidate.table === table);
    if (reader === undefined) continue;

    const after = index === resumeIndex ? resumeAfter : null;
    const read = await reader.read(after, remaining + 1);

    if (read.length > remaining) {
      const taken = read.slice(0, remaining);
      rows.set(
        table,
        taken.map((entry) => entry.row)
      );
      const last = taken.at(-1);
      return {
        rows,
        hasMore: true,
        next: { table, after: last === undefined ? after : last.key },
      };
    }

    rows.set(
      table,
      read.map((entry) => entry.row)
    );
    remaining -= read.length;
  }

  return { rows, hasMore: false, next: null };
};
