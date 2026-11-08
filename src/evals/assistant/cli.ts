import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { kbSnapshot } from "../../tests/fixtures/kbSnapshot.js";
import { casesFor } from "./cases/index.js";
import { parseEvalArgs, partOf, selectCases, type EvalOptions } from "./options.js";
import { renderSummary, toBaseline, type Report } from "./report.js";
import { BASELINE_PATH, runEnvVars } from "./runEnv.js";

const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, "eval-results");
const DATABASE_PREFIX = "flexi_day_eval_";

/** Exit codes: 0 every bar met, 1 a bar failed, 2 refused or misconfigured, 3 the harness broke. */
const EXIT = { ok: 0, bars: 1, refused: 2, broken: 3 } as const;

const fromDotenv = (file: string, key: string): string | undefined => {
  const path = resolve(ROOT, file);
  return existsSync(path) ? dotenv.parse(readFileSync(path))[key] : undefined;
};

/** The eval workspace's key: the environment first (CI), then the gitignored `.env.eval`. Never printed. */
const evalKey = (): string | undefined =>
  process.env.ANTHROPIC_EVAL_API_KEY || fromDotenv(".env.eval", "ANTHROPIC_EVAL_API_KEY");

/** A Postgres server to create the run's database on: `EVAL_DATABASE_SERVER`, else `.env`'s server. */
const databaseServer = (): string => {
  const explicit = process.env.EVAL_DATABASE_SERVER;
  if (explicit) return explicit;
  const local = process.env.DATABASE || fromDotenv(".env", "DATABASE");
  if (!local)
    throw new Error("Set EVAL_DATABASE_SERVER to a Postgres URL the eval may create databases on");
  const url = new URL(local);
  url.pathname = "/postgres";
  return url.toString();
};

const withDatabase = (server: string, name: string) => {
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
};

const admin = async <T>(server: string, run: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: server });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

const createDatabase = async (server: string): Promise<{ name: string; url: string }> => {
  const name = `${DATABASE_PREFIX}${Date.now()}_${randomBytes(3).toString("hex")}`;
  await admin(server, (client) => client.query(`CREATE DATABASE ${name}`));
  const url = withDatabase(server, name);
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(ROOT, "src/db/schema/out") });
  } finally {
    await pool.end();
  }
  return { name, url };
};

const dropDatabase = async (server: string, name: string) => {
  if (!name.startsWith(DATABASE_PREFIX) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to drop ${name}`);
  }
  await admin(server, (client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
};

const listCases = (options: EvalOptions) => {
  const selected = selectCases(casesFor(kbSnapshot()), options);
  for (const evalCase of selected) {
    process.stdout.write(
      `${evalCase.id}\t${partOf(evalCase)}\t${evalCase.lang}\t${evalCase.persona}${evalCase.smoke ? "\tsmoke" : ""}\n`
    );
  }
  process.stdout.write(`${selected.length} cases\n`);
};

const main = async (): Promise<number> => {
  const options = parseEvalArgs(process.argv.slice(2));
  if (options.list) {
    listCases(options);
    return EXIT.ok;
  }
  // Fail before spending anything on a selection that names no case.
  selectCases(casesFor(kbSnapshot()), options);

  const key = options.fake ? "" : evalKey();
  if (key === undefined || (!options.fake && key.length === 0)) {
    process.stderr.write(
      "No eval key: set ANTHROPIC_EVAL_API_KEY, or put it in .env.eval. A fork's pull request has none.\n"
    );
    return EXIT.refused;
  }

  const server = databaseServer();
  const database = await createDatabase(server);
  let status: number | null;
  try {
    const child = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.eval.config.ts"],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE: database.url,
          ASSISTANT_DRIVER: options.fake ? "fake" : "managed",
          ANTHROPIC_API_KEY: key,
          // The run makes its own agent version and pins it; ids from `.env` must not leak in.
          ASSISTANT_AGENT_ID: "",
          ASSISTANT_ENVIRONMENT_ID: "",
          ANTHROPIC_WEBHOOK_SECRET: "",
          LOG_DIR: join(OUT_DIR, "logs"),
          ...(options.model ? { ASSISTANT_MODEL: options.model } : {}),
          ...(options.effort ? { ASSISTANT_EFFORT: options.effort } : {}),
          ...runEnvVars({ options, outDir: OUT_DIR }),
        },
      }
    );
    status = child.status;
  } finally {
    await dropDatabase(server, database.name);
  }

  const reportPath = join(OUT_DIR, "report.json");
  if (status !== 0 || !existsSync(reportPath)) {
    process.stderr.write("The eval harness failed before it wrote a report.\n");
    return EXIT.broken;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const summary = renderSummary(report);
  process.stdout.write(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

  if (report.stopped?.reason === "spend_limit") return EXIT.refused;
  if (options.writeBaseline) {
    if (report.stopped) {
      process.stderr.write("Not writing a baseline from a run that stopped early.\n");
    } else {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(toBaseline(report), null, 2)}\n`);
      process.stdout.write(`Baseline written to ${BASELINE_PATH}\n`);
    }
  }
  return report.barsMet ? EXIT.ok : EXIT.bars;
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "The eval failed"}\n`);
    process.exit(EXIT.broken);
  }
);
