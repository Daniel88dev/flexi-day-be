import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, pool } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";

describe("pg pool errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a dropped idle connection and serves the next query", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const { rows } = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const pid = rows[0]?.pid;
    expect(pid).toBeTypeOf("number");

    // What an RDS restart or class change does to every idle connection.
    const admin = new pg.Client({ connectionString: pool.options.connectionString });
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend($1)", [pid]);
    } finally {
      await admin.end();
    }

    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(
        "Database pool connection error",
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    const next = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    expect(next.rows[0]?.ok).toBe(1);
  });
});
