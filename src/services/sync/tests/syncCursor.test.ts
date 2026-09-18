import { describe, it, expect } from "vitest";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  SYNC_CURSOR_MAX_AGE_MS,
  SYNC_CURSOR_VERSION,
  SYNC_OVERLAP_MS,
} from "../syncCursor.js";

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

    expect(decoded).toEqual({ version: SYNC_CURSOR_VERSION, cursorTime });
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
    });
    expect(decodeSyncCursor(encoded, behindByMore)).toBeNull();
  });
});
