import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestGroup,
  type TestContext,
  type TestGroup,
} from "./helpers/testSetup.js";

const MIGRATION = resolve(process.cwd(), "src/db/schema/out/0004_vacation_request_id.sql");

/**
 * Replays the real migration file against seeded rows, so the backfill that
 * production will run is what gets asserted, not a copy of it. Postgres DDL is
 * transactional: the column is dropped and re-created inside one transaction
 * that always rolls back, so the live schema is untouched afterwards.
 */
describe("Migration 0004: request id backfill", () => {
  let context: TestContext;
  let groupB: TestGroup;

  beforeAll(async () => {
    context = await setupTestEnvironment();
    groupB = await createTestGroup("Backfill Group B", context.user1.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("groups rows by user, group and creation timestamp, then forbids null", async () => {
    const t1 = new Date("2026-03-02T09:00:00.000Z");
    const t2 = new Date("2026-03-02T09:00:01.000Z");
    const seed = (userId: string, groupId: string, day: string, createdAt: Date) => ({
      id: uuidv4(),
      userId,
      groupId,
      requestedDay: day,
      // Placeholder only: the replayed migration drops and recomputes it.
      requestId: uuidv4(),
      createdAt,
      updatedAt: createdAt,
    });
    const rangeUser1GroupA = [
      seed(context.user1.id, context.group.id, "2026-03-09", t1),
      seed(context.user1.id, context.group.id, "2026-03-10", t1),
      seed(context.user1.id, context.group.id, "2026-03-11", t1),
    ];
    const laterUser1GroupA = seed(context.user1.id, context.group.id, "2026-03-13", t2);
    const user1GroupB = seed(context.user1.id, groupB.id, "2026-03-16", t1);
    const user2GroupA = seed(context.user2.id, context.group.id, "2026-03-09", t1);
    const seeded = [...rangeUser1GroupA, laterUser1GroupA, user1GroupB, user2GroupA];

    const statements = readFileSync(MIGRATION, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(1);

    const rollback = new Error("rollback");
    let result: { id: string; requestId: string | null }[] = [];
    let nullable: string | undefined;
    await db
      .transaction(async (tx) => {
        await tx.delete(vacation);
        await tx.insert(vacation).values(seeded);
        await tx.execute(sql`ALTER TABLE "vacation" DROP COLUMN "request_id"`);
        for (const statement of statements) {
          await tx.execute(sql.raw(statement));
        }
        result = await tx.select({ id: vacation.id, requestId: vacation.requestId }).from(vacation);
        const column = await tx.execute(
          sql`SELECT is_nullable FROM information_schema.columns
              WHERE table_name = 'vacation' AND column_name = 'request_id'`
        );
        nullable = (column.rows[0] as { is_nullable: string } | undefined)?.is_nullable;
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });

    expect(result).toHaveLength(seeded.length);
    const byId = new Map(result.map((r) => [r.id, r.requestId]));
    const idOf = (row: { id: string }) => byId.get(row.id);

    const rangeIds = new Set(rangeUser1GroupA.map(idOf));
    expect(rangeIds.size).toBe(1);
    const [rangeId] = rangeIds;
    expect(rangeId).toEqual(expect.any(String));

    expect(idOf(laterUser1GroupA)).not.toBe(rangeId);
    expect(idOf(user1GroupB)).not.toBe(rangeId);
    expect(idOf(user2GroupA)).not.toBe(rangeId);
    expect(new Set([idOf(laterUser1GroupA), idOf(user1GroupB), idOf(user2GroupA)]).size).toBe(3);
    expect(result.every((r) => r.requestId !== null)).toBe(true);

    expect(nullable).toBe("NO");

    // Rolled back: the placeholder ids seeded above are gone with the rest.
    const after = await db.select({ id: vacation.id }).from(vacation);
    expect(after.map((r) => r.id)).not.toContain(rangeUser1GroupA[0]?.id);
  });
});
