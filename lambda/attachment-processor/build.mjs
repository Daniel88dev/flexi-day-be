// Builds attachment-processor.zip next to this file: the handler and the
// shared processor bundled into one ESM file, plus sharp and libheif-js
// installed for the Lambda's linux/x64 runtime. `npm run lambda:build` from
// the repo root runs it; CD uploads the result with `aws lambda update-function-code`.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const dist = path.join(here, "dist");
const zip = path.join(here, "attachment-processor.zip");

rmSync(dist, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(dist);

await build({
  entryPoints: [path.join(repo, "src/lambda/attachmentProcessor/index.ts")],
  outfile: path.join(dist, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Native and wasm modules stay outside the bundle and load from node_modules.
  external: ["sharp", "libheif-js"],
  // Bundled CommonJS dependencies may still call require() at runtime.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
});

for (const file of ["package.json", "package-lock.json"]) {
  cpSync(path.join(here, file), path.join(dist, file));
}
execFileSync(
  "npm",
  [
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--os=linux",
    "--cpu=x64",
    "--libc=glibc",
  ],
  { cwd: dist, stdio: "inherit" }
);

execFileSync("zip", ["-qrX", zip, "."], { cwd: dist, stdio: "inherit" });
console.log(`${path.relative(repo, zip)}: ${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB`);
