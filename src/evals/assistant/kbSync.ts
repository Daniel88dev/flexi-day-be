import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { kbBundleSchema } from "../../services/knowledgeBase/bundle.js";
import { KB_SNAPSHOT_PATH } from "../../tests/fixtures/kbSnapshot.js";
import { goldenQuestionsOf } from "./cases/index.js";
import { LIVE_BUNDLE_URL } from "./runEnv.js";

/**
 * `pnpm run eval:kb-sync [--from <url or file>]`: replaces the committed KB
 * snapshot, which PR eval runs and the e2e suite both read, with the
 * production `/help/kb.json` or the given bundle (a local `next dev`, or
 * `../flexi-day/out/help/kb.json` after a frontend build).
 */
const main = async () => {
  const at = process.argv.indexOf("--from");
  const from = at >= 0 ? process.argv[at + 1] : LIVE_BUNDLE_URL;
  if (!from) throw new Error("--from needs a URL or a file");

  let text: string;
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from);
    if (!res.ok) throw new Error(`${from} answered ${res.status}`);
    text = await res.text();
  } else {
    if (!existsSync(from)) throw new Error(`No file ${from}`);
    text = readFileSync(from, "utf8");
  }
  const bundle = JSON.parse(text) as unknown;
  const parsed = kbBundleSchema.parse(bundle);

  writeFileSync(KB_SNAPSHOT_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
  const formatted = spawnSync("pnpm", ["exec", "prettier", "--write", KB_SNAPSHOT_PATH], {
    stdio: "inherit",
  });
  if (formatted.status !== 0) throw new Error("prettier failed on the snapshot");
  const golden = goldenQuestionsOf(bundle).length;
  process.stdout.write(
    `KB snapshot ${parsed.version}: ${parsed.languages.en.articles.length} articles per language, ${golden} golden questions.\n` +
      "Run search.test.ts, docsTools.test.ts and mcpDocsTools.e2e.test.ts against it before committing.\n"
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "kb-sync failed"}\n`);
  process.exit(1);
});
