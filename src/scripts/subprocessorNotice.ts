// Usage: pnpm run subprocessor-notice --dry-run | --send
// Day 0 of the launch runs it against production; docs/terraform.md, "Launch", says how.
import { pool } from "../db/db.js";
import { runSubprocessorNotice } from "../services/subprocessorNotice/subprocessorNoticeServices.js";

const argv = process.argv.slice(2);

// The same rule as db:migrate:prod: real mail goes out only from a person at a terminal.
if (argv.includes("--send") && !process.stdin.isTTY) {
  console.error("Sending the notice needs an interactive terminal; --dry-run works anywhere.");
  await pool.end();
  process.exit(1);
}

const code = await runSubprocessorNotice(argv, {
  print: (line) => console.log(line),
}).finally(() => pool.end());
process.exit(code);
