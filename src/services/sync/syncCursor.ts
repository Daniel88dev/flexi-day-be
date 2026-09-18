import type { SyncCursor } from "./types.js";

export const SYNC_CURSOR_VERSION = 1;

/** Past this age a cursor cannot be trusted to have covered hard deletes, so the pull resets. */
export const SYNC_CURSOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type SyncCursorBody = {
  v: number;
  t: string;
};

export const encodeSyncCursor = (cursorTime: Date): string => {
  const body: SyncCursorBody = { v: SYNC_CURSOR_VERSION, t: cursorTime.toISOString() };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
};

/** Null for anything a delta cannot be built from: unreadable, another version, or expired. */
export const decodeSyncCursor = (value: string, now: Date = new Date()): SyncCursor | null => {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null) return null;

  const { v, t } = body as Partial<SyncCursorBody>;
  if (v !== SYNC_CURSOR_VERSION || typeof t !== "string") return null;

  const cursorTime = new Date(t);
  if (Number.isNaN(cursorTime.getTime())) return null;
  if (now.getTime() - cursorTime.getTime() > SYNC_CURSOR_MAX_AGE_MS) return null;

  return { version: v, cursorTime };
};
