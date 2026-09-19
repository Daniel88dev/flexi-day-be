import { describe, it, expect } from "vitest";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  SYNC_CURSOR_MAX_AGE_MS,
  SYNC_CURSOR_VERSION,
  SYNC_OVERLAP_MS,
} from "../syncCursor.js";
import type { SyncCursorPage } from "../types.js";

const decodeBody = (cursor: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;

const encodeBody = (body: unknown): string =>
  Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

describe("sync cursor codec", () => {
  it("encodes the version and cursor time as base64url JSON", () => {
    const cursorTime = new Date("2026-09-18T10:00:00.000Z");

    const encoded = encodeSyncCursor(cursorTime);

    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(decodeBody(encoded)).toEqual({
      v: SYNC_CURSOR_VERSION,
      t: "2026-09-18T10:00:00.000Z",
    });
  });

  it("round-trips a cursor time", () => {
    const cursorTime = new Date("2026-09-18T10:00:00.000Z");

    const decoded = decodeSyncCursor(encodeSyncCursor(cursorTime), cursorTime);

    expect(decoded).toEqual({ version: SYNC_CURSOR_VERSION, cursorTime, page: null });
  });

  it("rejects a cursor it cannot decode", () => {
    expect(decodeSyncCursor("not-a-cursor")).toBeNull();
    expect(decodeSyncCursor("")).toBeNull();
    expect(decodeSyncCursor(encodeBody("a string, not an object"))).toBeNull();
  });

  it("rejects a cursor minted by another version", () => {
    const encoded = encodeBody({ v: SYNC_CURSOR_VERSION + 1, t: "2026-09-18T10:00:00.000Z" });

    expect(decodeSyncCursor(encoded)).toBeNull();
  });

  it("rejects a cursor whose time is missing or unparseable", () => {
    expect(decodeSyncCursor(encodeBody({ v: SYNC_CURSOR_VERSION }))).toBeNull();
    expect(decodeSyncCursor(encodeBody({ v: SYNC_CURSOR_VERSION, t: "yesterday" }))).toBeNull();
  });

  it("accepts a cursor inside the expiry window and rejects one past it", () => {
    const cursorTime = new Date("2026-09-18T10:00:00.000Z");
    const encoded = encodeSyncCursor(cursorTime);

    const insideWindow = new Date(cursorTime.getTime() + SYNC_CURSOR_MAX_AGE_MS - 1000);
    const pastWindow = new Date(cursorTime.getTime() + SYNC_CURSOR_MAX_AGE_MS + 1000);

    expect(decodeSyncCursor(encoded, insideWindow)).toEqual({
      version: SYNC_CURSOR_VERSION,
      cursorTime,
      page: null,
    });
    expect(decodeSyncCursor(encoded, pastWindow)).toBeNull();
  });

  it("holds the expiry boundary to the millisecond", () => {
    const cursorTime = new Date("2026-09-18T10:00:00.000Z");
    const encoded = encodeSyncCursor(cursorTime);

    const exactlyAtTheLimit = new Date(cursorTime.getTime() + SYNC_CURSOR_MAX_AGE_MS);
    const oneMillisecondPast = new Date(cursorTime.getTime() + SYNC_CURSOR_MAX_AGE_MS + 1);

    expect(decodeSyncCursor(encoded, exactlyAtTheLimit)).toEqual({
      version: SYNC_CURSOR_VERSION,
      cursorTime,
      page: null,
    });
    expect(decodeSyncCursor(encoded, oneMillisecondPast)).toBeNull();
  });

  it("accepts a cursor minted up to one overlap window ahead of the clock reading it", () => {
    const cursorTime = new Date("2026-09-18T10:00:00.000Z");
    const encoded = encodeSyncCursor(cursorTime);

    const behindByTheOverlap = new Date(cursorTime.getTime() - SYNC_OVERLAP_MS);
    const behindByMore = new Date(cursorTime.getTime() - SYNC_OVERLAP_MS - 1);

    expect(decodeSyncCursor(encoded, behindByTheOverlap)).toEqual({
      version: SYNC_CURSOR_VERSION,
      cursorTime,
      page: null,
    });
    expect(decodeSyncCursor(encoded, behindByMore)).toBeNull();
  });
});

describe("sync cursor paging state", () => {
  const cursorTime = new Date("2026-09-18T10:00:00.000Z");
  const previousCursorTime = new Date("2026-09-18T09:00:00.000Z");
  const stoppedAt = new Date("2026-09-17T08:30:00.000Z");

  const snapshotPage: SyncCursorPage = {
    reset: true,
    previousCursorTime: null,
    position: { table: "groupUsers", after: { updatedAt: stoppedAt, id: "member-42" } },
  };

  it("carries the page state in the cursor body, beside the unchanged cursor time", () => {
    const encoded = encodeSyncCursor(cursorTime, snapshotPage);

    expect(decodeBody(encoded)).toEqual({
      v: SYNC_CURSOR_VERSION,
      t: "2026-09-18T10:00:00.000Z",
      p: {
        r: true,
        tb: "groupUsers",
        ua: "2026-09-17T08:30:00.000Z",
        id: "member-42",
      },
    });
  });

  it("round-trips the page state of a snapshot loop", () => {
    const decoded = decodeSyncCursor(encodeSyncCursor(cursorTime, snapshotPage), cursorTime);

    expect(decoded).toEqual({ version: SYNC_CURSOR_VERSION, cursorTime, page: snapshotPage });
  });

  it("round-trips the page state of a delta loop, including the cursor it started from", () => {
    const deltaPage: SyncCursorPage = {
      reset: false,
      previousCursorTime,
      position: { table: "groups", after: { updatedAt: stoppedAt, id: "group-7" } },
    };

    const decoded = decodeSyncCursor(encodeSyncCursor(cursorTime, deltaPage), cursorTime);

    expect(decoded).toEqual({ version: SYNC_CURSOR_VERSION, cursorTime, page: deltaPage });
  });

  it("round-trips a position at the start of a table", () => {
    const page: SyncCursorPage = {
      reset: true,
      previousCursorTime: null,
      position: { table: "groups", after: null },
    };

    const decoded = decodeSyncCursor(encodeSyncCursor(cursorTime, page), cursorTime);

    expect(decoded?.page).toEqual(page);
  });

  it("round-trips a position in a table ordered by id alone", () => {
    const page: SyncCursorPage = {
      reset: true,
      previousCursorTime: null,
      position: { table: "organizations", after: { updatedAt: null, id: "org-3" } },
    };

    const decoded = decodeSyncCursor(encodeSyncCursor(cursorTime, page), cursorTime);

    expect(decoded?.page).toEqual(page);
  });

  it("reads a cursor minted before paging existed as a fresh pull", () => {
    const oldShape = encodeBody({ v: SYNC_CURSOR_VERSION, t: cursorTime.toISOString() });

    expect(decodeSyncCursor(oldShape, cursorTime)).toEqual({
      version: SYNC_CURSOR_VERSION,
      cursorTime,
      page: null,
    });
  });

  it("rejects page state naming a table the envelope does not carry", () => {
    const encoded = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: true, tb: "attendance", ua: stoppedAt.toISOString(), id: "row-1" },
    });

    expect(decodeSyncCursor(encoded, cursorTime)).toBeNull();
  });

  it("rejects page state that is not an object or carries no reset flag", () => {
    const withoutFlag = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { tb: "groups" },
    });
    const notAnObject = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: "groups",
    });

    expect(decodeSyncCursor(withoutFlag, cursorTime)).toBeNull();
    expect(decodeSyncCursor(notAnObject, cursorTime)).toBeNull();
  });

  it("rejects a delta loop with no cursor to continue from", () => {
    const encoded = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: false, tb: "groups", ua: stoppedAt.toISOString(), id: "group-7" },
    });

    expect(decodeSyncCursor(encoded, cursorTime)).toBeNull();
  });

  it("rejects page state whose timestamps cannot be read", () => {
    const badPosition = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: true, tb: "groups", ua: "yesterday", id: "group-7" },
    });
    const badPrevious = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: false, s: "yesterday", tb: "groups", ua: stoppedAt.toISOString(), id: "group-7" },
    });

    expect(decodeSyncCursor(badPosition, cursorTime)).toBeNull();
    expect(decodeSyncCursor(badPrevious, cursorTime)).toBeNull();
  });

  it("rejects a keyset without its timestamp in a table ordered by updatedAt then id", () => {
    const noTimestamp = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: true, tb: "groupUsers", id: "member-42" },
    });
    const nullTimestamp = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: true, tb: "groupUsers", ua: null, id: "member-42" },
    });
    const timestampWhereNoneBelongs = encodeBody({
      v: SYNC_CURSOR_VERSION,
      t: cursorTime.toISOString(),
      p: { r: true, tb: "organizations", ua: stoppedAt.toISOString(), id: "org-3" },
    });

    expect(decodeSyncCursor(noTimestamp, cursorTime)).toBeNull();
    expect(decodeSyncCursor(nullTimestamp, cursorTime)).toBeNull();
    expect(decodeSyncCursor(timestampWhereNoneBelongs, cursorTime)).toBeNull();
  });

  it("rejects a delta loop that started after the cursor time it carries", () => {
    const page: SyncCursorPage = {
      reset: false,
      previousCursorTime: new Date(cursorTime.getTime() + 1),
      position: { table: "groups", after: null },
    };

    expect(decodeSyncCursor(encodeSyncCursor(cursorTime, page), cursorTime)).toBeNull();
  });

  it("rejects a delta loop reaching back further than the expiry window", () => {
    const tooOld = new Date(cursorTime.getTime() - SYNC_CURSOR_MAX_AGE_MS - 1);
    const page: SyncCursorPage = {
      reset: false,
      previousCursorTime: tooOld,
      position: { table: "groups", after: null },
    };

    expect(decodeSyncCursor(encodeSyncCursor(cursorTime, page), cursorTime)).toBeNull();
  });

  it("rejects page state on a cursor that has expired, like any other unusable cursor", () => {
    const encoded = encodeSyncCursor(cursorTime, snapshotPage);
    const pastWindow = new Date(cursorTime.getTime() + SYNC_CURSOR_MAX_AGE_MS + 1);

    expect(decodeSyncCursor(encoded, pastWindow)).toBeNull();
  });
});
