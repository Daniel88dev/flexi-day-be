import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const DEV_TOKEN = "local-dev-token-0123456789";

// Mocked rather than enabled through the environment: `parseDevTools` refuses a
// database host that is not localhost, and the containerised suite reaches its
// Postgres as `postgres`.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      dev: { token: "local-dev-token-0123456789", seedEmailDomain: "dev.local" },
    },
  };
});

type SeededCounts = { bookings: number; rejected: number; events: number };

const seededCounts = async (): Promise<SeededCounts> => {
  const result = await db.execute<SeededCounts>(sql`
    select
      count(*)::int as bookings,
      count(*) filter (where v.rejected_at is not null)::int as rejected,
      (select count(*)::int
         from vacation_events e
         join vacation ev on ev.id = e.vacation_id
         join "user" eu on eu.id = ev.user_id
        where eu.email like '%@dev.local') as events
    from vacation v
    join "user" u on u.id = v.user_id
    where u.email like '%@dev.local'
  `);
  return result.rows[0]!;
};

describe("dev scenario", () => {
  let server: LoopbackServer;

  const runScenario = () =>
    request(server.url).post("/api/dev/scenario").set("x-dev-token", DEV_TOKEN).send({});

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  it("re-runs on the same day without adding bookings or events, rejected ones included", async () => {
    const first = await runScenario();
    expect(first.status).toBe(201);
    const afterFirst = await seededCounts();
    expect(afterFirst.rejected).toBeGreaterThan(0);
    expect(first.body.vacationsCreated).toBe(afterFirst.bookings);

    const second = await runScenario();
    expect(second.status).toBe(201);
    expect(second.body.vacationsCreated).toBe(0);
    expect(await seededCounts()).toEqual(afterFirst);
  });
});
