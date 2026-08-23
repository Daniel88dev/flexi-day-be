#!/usr/bin/env node
// Applies pending migrations and says so when it fails.
//
// `drizzle-kit migrate` exits non-zero with an empty stderr. A production run
// that hit `type "..." already exists` printed nothing at all and looked like a
// no-op, which is how a maintenance window got spent on a migration that had
// not run. The migrator underneath is the same one; only the reporting differs.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE;
if (!url) {
  console.error("DATABASE is required");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder: "src/db/schema/out" });
  console.log("migrations applied");
} catch (err) {
  console.error("");
  console.error("migration FAILED, nothing was committed:");
  console.error(`  ${err.message?.split("\n")[0] ?? err}`);
  if (err.cause?.message) console.error(`  cause: ${err.cause.message}`);
  if (/already exists/.test(err.cause?.message ?? "")) {
    console.error("");
    console.error("  This looks like the squashed baseline being replayed over a");
    console.error("  database that already has those objects. Check the ledger with");
    console.error("  `--status`: if it holds the pre-squash entries, reconcile it with");
    console.error("  `--baseline` before migrating. See docs/better-auth-1.7-migration.md.");
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
