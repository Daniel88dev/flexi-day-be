// Usage: pnpm run assistant:reconcile --month <YYYY-MM> --report <file> [--workspace <id>]
// Run by hand each month against the database of the deployment whose workspace the report
// names. docs/assistant-usage.md says how to fetch the report.
import { readFile } from "node:fs/promises";
import { pool } from "../db/db.js";
import { runReconcile } from "../services/assistant/meter/reconcile.js";

const code = await runReconcile(process.argv.slice(2), {
  // The operator names the report file on the command line.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFile: (file) => readFile(file, "utf8"),
  print: (line) => console.log(line),
}).finally(() => pool.end());
process.exit(code);
