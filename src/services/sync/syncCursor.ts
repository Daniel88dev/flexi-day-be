import { ID_ORDERED_TABLES, SYNC_TABLE_ORDER } from "./syncPage.js";
import type { SyncCursor, SyncCursorPage, SyncKeyset, SyncTableName } from "./types.js";

export const SYNC_CURSOR_VERSION = 1;

/** Past this age a cursor cannot be trusted to have covered hard deletes, so the pull resets. */
export const SYNC_CURSOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A delta reaches back one overlap window before the cursor. Inserts stamp
 * `updatedAt` from the database and updates from whichever App Runner instance
 * ran them, so a row committed by a clock behind the one that minted the
 * cursor would otherwise fall between two pulls and never arrive. The price is
 * that a row can arrive twice; the client upserts, so the second is a no-op.
 * The same window bounds how far ahead of the reading clock a cursor may sit:
 * further than that, the overlap no longer covers the gap, so the pull resets.
 */
export const SYNC_OVERLAP_MS = 60 * 1000;

/**
 * Version 1 carries the paging state in an optional `p`, so a cursor minted
 * before paging existed still decodes — it simply asks for a fresh pull.
 */
type SyncCursorPageBody = {
  /** True when the loop is a snapshot, so every page of it answers `reset: true`. */
  r: boolean;
  /** The cursor the loop started from, on a delta loop only. */
  s?: string;
  tb: SyncTableName;
  ua?: string | null;
  id?: string;
};

type SyncCursorBody = {
  v: number;
  t: string;
  p?: SyncCursorPageBody;
};

const encodePage = (page: SyncCursorPage): SyncCursorPageBody => ({
  r: page.reset,
  ...(page.previousCursorTime === null ? {} : { s: page.previousCursorTime.toISOString() }),
  tb: page.position.table,
  ...(page.position.after === null
    ? {}
    : {
        ua: page.position.after.updatedAt?.toISOString() ?? null,
        id: page.position.after.id,
      }),
});

export const encodeSyncCursor = (cursorTime: Date, page: SyncCursorPage | null = null): string => {
  const body: SyncCursorBody = {
    v: SYNC_CURSOR_VERSION,
    t: cursorTime.toISOString(),
    ...(page === null ? {} : { p: encodePage(page) }),
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
};

const readDate = (value: string): Date | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isTableName = (value: unknown): value is SyncTableName =>
  typeof value === "string" && SYNC_TABLE_ORDER.includes(value as SyncTableName);

const hasExpired = (cursorTime: Date, now: Date): boolean =>
  now.getTime() - cursorTime.getTime() > SYNC_CURSOR_MAX_AGE_MS;

/** Null for page state the walk cannot resume from, which makes the whole cursor unusable. */
const decodePage = (body: unknown, cursorTime: Date, now: Date): SyncCursorPage | null => {
  if (typeof body !== "object" || body === null) return null;

  const { r, s, tb, ua, id } = body as Partial<SyncCursorPageBody>;
  if (typeof r !== "boolean" || !isTableName(tb)) return null;

  let after: SyncKeyset | null = null;
  if (id !== undefined) {
    if (typeof id !== "string") return null;
    if (ID_ORDERED_TABLES.has(tb)) {
      if (ua !== null && ua !== undefined) return null;
      after = { updatedAt: null, id };
    } else {
      // A keyset without its timestamp would resume on `id` alone and skip
      // rows that sort after the cursor by time but before it by id.
      if (typeof ua !== "string") return null;
      const updatedAt = readDate(ua);
      if (updatedAt === null) return null;
      after = { updatedAt, id };
    }
  }

  const position = { table: tb, after };
  if (r) return { reset: true, previousCursorTime: null, position };

  if (typeof s !== "string") return null;
  const previousCursorTime = readDate(s);
  if (previousCursorTime === null) return null;
  // The loop it continues would otherwise reach back further than a fresh
  // cursor of the same age is allowed to, or start after the time it ends.
  if (hasExpired(previousCursorTime, now)) return null;
  if (previousCursorTime.getTime() > cursorTime.getTime()) return null;

  return { reset: false, previousCursorTime, position };
};

/** Null for anything a pull cannot continue from: unreadable, another version, expired, ahead of the clock, or page state the walk cannot resume. */
export const decodeSyncCursor = (value: string, now: Date = new Date()): SyncCursor | null => {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null) return null;

  const { v, t, p } = body as Partial<SyncCursorBody>;
  if (v !== SYNC_CURSOR_VERSION || typeof t !== "string") return null;

  const cursorTime = new Date(t);
  if (Number.isNaN(cursorTime.getTime())) return null;
  if (hasExpired(cursorTime, now)) return null;
  if (cursorTime.getTime() - now.getTime() > SYNC_OVERLAP_MS) return null;

  if (p === undefined) return { version: v, cursorTime, page: null };

  const page = decodePage(p, cursorTime, now);
  if (page === null) return null;

  return { version: v, cursorTime, page };
};
