import pg from "pg";
import { vi } from "vitest";

/**
 * Unit tests run without a database. See
 * `docs/adr/0009-unit-tests-refuse-query-execution.md` for why this refuses execution
 * rather than access, and why the cheaper `pg.Pool.prototype` patch is only the backstop.
 */

const GUARD = "src/tests/noRealDatabase.ts";

// Where the query was built, not where it ran: `await` invokes a thenable's `then` from a
// microtask, by which point the calling module has left the stack.
const buildSite = (): string | undefined => {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  for (const frame of frames) {
    const [captured] = frame.match(/(?:\/|file:\/\/\/)\S*\/src\/\S*?\.ts/) ?? [];
    if (!captured) continue;
    const path = captured.replace(/^file:\/\//, "").replace(/^.*\/flexi-day-be\//, "");
    if (!path.startsWith(GUARD)) return path;
  }
  return undefined;
};

const refuse = (operation: string, origin: string | undefined): never => {
  throw new Error(
    `This unit test executed a database query (db.${operation}) from ` +
      `${origin ?? "a module the guard could not identify"}. Unit tests run without a ` +
      `database, so mock the module that queries, for example:\n\n` +
      `  vi.mock("<relative path>/db/db.js", () => ({\n` +
      `    db: { transaction: vi.fn((run) => run({})) },\n` +
      `  }));\n\n` +
      `A test that wants a real database belongs in the e2e suite, as *.e2e.test.ts.`
  );
};

// `then` and `execute` run the query; everything else composes it and must keep working,
// because modules build SQL fragments at import time and never execute them.
const RUNS_THE_QUERY = new Set(["then", "catch", "finally", "execute"]);

const executable = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  (typeof (value as { then?: unknown }).then === "function" ||
    typeof (value as { execute?: unknown }).execute === "function");

const guardBuilder = (builder: object, operation: string, origin: string | undefined): object =>
  new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && RUNS_THE_QUERY.has(prop)) {
        return () => refuse(operation, origin);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return executable(result) ? guardBuilder(result, operation, origin) : result;
      };
    },
  });

// Chained drizzle builders return fresh objects, so each entry point is wrapped on the way
// out rather than once on `db` itself.
const ENTRY_POINTS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "insert",
  "update",
  "delete",
  "execute",
  "$count",
  "refreshMaterializedView",
]);

const guardDb = (db: object): object =>
  new Proxy(db, {
    get(target, prop, receiver) {
      // A transaction always runs; nothing composes one, so it can refuse at the call
      // site, where the calling module is still on the stack.
      if (prop === "transaction") {
        return () => refuse("transaction", buildSite());
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || !ENTRY_POINTS.has(prop)) {
        return value;
      }
      return (...args: unknown[]) => {
        const origin = buildSite();
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return typeof result === "object" && result !== null
          ? guardBuilder(result, prop, origin)
          : result;
      };
    },
  });

// A per-file `vi.mock` of the same path takes precedence over this one, so the files that
// already stub `db` keep their own stub.
vi.mock("../db/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/db.js")>();
  return { ...actual, db: guardDb(actual.db) };
});

// Backstop for code that reaches the exported `pool` instead of `db`. It fires across an
// await boundary, so it cannot name the caller; reaching it for a plain `db` query means
// the interception above has stopped working.
const refusePool = (): never => {
  throw new Error(
    `This unit test opened a database connection through the pg pool directly. Unit tests ` +
      `run without a database. If this came from an ordinary db.select() or ` +
      `db.transaction(), the drizzle interception in ${GUARD} has stopped working, most ` +
      `likely after a drizzle upgrade: see docs/adr/0009-unit-tests-refuse-query-execution.md.`
  );
};

pg.Pool.prototype.connect = refusePool as unknown as pg.Pool["connect"];
pg.Pool.prototype.query = refusePool as unknown as pg.Pool["query"];
