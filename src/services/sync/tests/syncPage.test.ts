import { describe, it, expect } from "vitest";
import { collectSyncPage, SYNC_PAGE_SIZE, SYNC_TABLE_ORDER } from "../syncPage.js";
import type { SyncKeyset, SyncPage, SyncTableName, SyncTableReader } from "../types.js";

type FakeRow = { id: string; updatedAt: Date };

const fakeRows = (prefix: string, count: number): FakeRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index.toString().padStart(5, "0")}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  }));

/** A reader over an in-memory array, paged the way a keyset query would page it. */
const readerOver = (table: SyncTableName, rows: FakeRow[]) => {
  const calls: { after: SyncKeyset | null; limit: number }[] = [];
  const reader: SyncTableReader = {
    table,
    read: (after, limit) => {
      calls.push({ after, limit });
      const from = after === null ? 0 : rows.findIndex((row) => row.id === after.id) + 1;
      return Promise.resolve(
        rows.slice(from, from + limit).map((row) => ({
          key: { updatedAt: row.updatedAt, id: row.id },
          row,
        }))
      );
    },
  };
  return { reader, calls };
};

const idsOf = (page: SyncPage, table: SyncTableName): string[] =>
  ((page.rows.get(table) ?? []) as FakeRow[]).map((row) => row.id);

describe("sync page splitter", () => {
  it("fixes the page size at 1000 rows across all tables", () => {
    expect(SYNC_PAGE_SIZE).toBe(1000);
  });

  it("walks the tables in dependency order", () => {
    expect(SYNC_TABLE_ORDER).toEqual([
      "organizations",
      "users",
      "groups",
      "groupUsers",
      "groupMirrors",
      "userYearQuotas",
      "bankHolidays",
      "vacations",
    ]);
  });

  it("answers one page when the whole result fits", async () => {
    const groups = readerOver("groups", fakeRows("group", 3));
    const memberships = readerOver("groupUsers", fakeRows("member", 2));

    const page = await collectSyncPage([groups.reader, memberships.reader], null, 10);

    expect(idsOf(page, "groups")).toHaveLength(3);
    expect(idsOf(page, "groupUsers")).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.next).toBeNull();
  });

  it("leaves a table with no reader empty", async () => {
    const groups = readerOver("groups", fakeRows("group", 1));

    const page = await collectSyncPage([groups.reader], null, 10);

    expect(page.rows.get("users")).toEqual([]);
    expect(page.rows.get("vacations")).toEqual([]);
    expect([...page.rows.keys()]).toEqual([...SYNC_TABLE_ORDER]);
  });

  it("stops at the page boundary and reports the table and row it stopped on", async () => {
    const groupRows = fakeRows("group", 600);
    const membershipRows = fakeRows("member", 600);
    const groups = readerOver("groups", groupRows);
    const memberships = readerOver("groupUsers", membershipRows);

    const page = await collectSyncPage([groups.reader, memberships.reader], null, 1000);

    expect(idsOf(page, "groups")).toEqual(groupRows.map((row) => row.id));
    expect(idsOf(page, "groupUsers")).toEqual(membershipRows.slice(0, 400).map((row) => row.id));
    expect(page.hasMore).toBe(true);
    expect(page.next).toEqual({
      table: "groupUsers",
      after: { updatedAt: membershipRows[399]!.updatedAt, id: membershipRows[399]!.id },
    });
  });

  it("resumes inside the table the previous page stopped in, without re-reading the tables before it", async () => {
    const groupRows = fakeRows("group", 600);
    const membershipRows = fakeRows("member", 600);
    const groups = readerOver("groups", groupRows);
    const memberships = readerOver("groupUsers", membershipRows);

    const first = await collectSyncPage([groups.reader, memberships.reader], null, 1000);
    const second = await collectSyncPage([groups.reader, memberships.reader], first.next, 1000);

    expect(second.rows.get("groups")).toEqual([]);
    expect(idsOf(second, "groupUsers")).toEqual(membershipRows.slice(400).map((row) => row.id));
    expect(second.hasMore).toBe(false);
    expect(second.next).toBeNull();
    expect(groups.calls).toHaveLength(1);
  });

  it("returns no row twice and skips none across a whole loop", async () => {
    const membershipRows = fakeRows("member", 2500);
    const memberships = readerOver("groupUsers", membershipRows);

    const seen: string[] = [];
    let next = null as Awaited<ReturnType<typeof collectSyncPage>>["next"];
    let pages = 0;
    do {
      const page = await collectSyncPage([memberships.reader], next, 1000);
      seen.push(...idsOf(page, "groupUsers"));
      next = page.hasMore ? page.next : null;
      pages += 1;
    } while (next !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(membershipRows.map((row) => row.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("reports another page when the boundary falls on the last row of a table", async () => {
    const groupRows = fakeRows("group", 1000);
    const groups = readerOver("groups", groupRows);
    const memberships = readerOver("groupUsers", fakeRows("member", 5));

    const page = await collectSyncPage([groups.reader, memberships.reader], null, 1000);

    expect(idsOf(page, "groups")).toHaveLength(1000);
    expect(page.rows.get("groupUsers")).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(page.next).toEqual({ table: "groupUsers", after: null });
  });

  it("resumes at the start of a table when that is where the previous page stopped", async () => {
    const membershipRows = fakeRows("member", 5);
    const memberships = readerOver("groupUsers", membershipRows);

    const page = await collectSyncPage(
      [memberships.reader],
      { table: "groupUsers", after: null },
      1000
    );

    expect(idsOf(page, "groupUsers")).toEqual(membershipRows.map((row) => row.id));
    expect(page.hasMore).toBe(false);
  });

  it("closes the loop when the last table ends exactly on the boundary", async () => {
    const groups = readerOver("groups", fakeRows("group", 1000));

    const page = await collectSyncPage([groups.reader], null, 1000);

    expect(idsOf(page, "groups")).toHaveLength(1000);
    expect(page.hasMore).toBe(false);
    expect(page.next).toBeNull();
  });

  it("answers an empty page for a caller with nothing to sync", async () => {
    const page = await collectSyncPage([], null, 1000);

    expect([...page.rows.values()].every((rows) => rows.length === 0)).toBe(true);
    expect(page.hasMore).toBe(false);
    expect(page.next).toBeNull();
  });
});
