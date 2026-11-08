import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/assistant-eval-changes.sh");

const deps = (sdk: string, zod: string) =>
  `{\n  "dependencies": {\n    "@anthropic-ai/sdk": "${sdk}",\n    "zod": "${zod}"\n  }\n}\n`;

describe("which pull requests run the Assistant eval", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
  };
  const decide = () =>
    execFileSync("bash", [SCRIPT, "base", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "eval-changes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    commit({
      "src/config.ts":
        'const model = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";\nconst port = 8080;\n',
      "package.json": deps("^1.5.0", "^4.0.0"),
      "src/routes/vacationRouter.ts": "export {};\n",
    });
    git("branch", "base");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("skips a change outside the Assistant's paths", () => {
    commit({ "src/routes/vacationRouter.ts": "export const x = 1;\n" });
    expect(decide()).toBe("run=false");
  });

  it.each([
    "src/services/assistant/agent/agentConfig.ts",
    "src/services/assistant/screen/screenPrompt.ts",
    "src/services/assistant/meter/prices.ts",
    "src/tools/reads/balances.ts",
    "src/evals/assistant/cases/offTopic.ts",
    "src/tests/fixtures/kb-snapshot.json",
    ".github/workflows/assistant-eval.yml",
  ])("runs when %s changes", (path) => {
    commit({ [path]: "changed\n" });
    expect(decide()).toBe("run=true");
  });

  it("runs on a model config change in config.ts, not on any other line there", () => {
    commit({
      "src/config.ts":
        'const model = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";\nconst port = 8081;\n',
    });
    expect(decide()).toBe("run=false");
    commit({
      "src/config.ts":
        'const model = process.env.ASSISTANT_MODEL || "claude-haiku-5-5";\nconst port = 8081;\n',
    });
    expect(decide()).toBe("run=true");
  });

  it("runs on an Anthropic SDK version change, not on another dependency", () => {
    commit({ "package.json": deps("^1.5.0", "^4.1.0") });
    expect(decide()).toBe("run=false");
    commit({ "package.json": deps("^1.6.0", "^4.1.0") });
    expect(decide()).toBe("run=true");
  });
});
