import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../../terraform/scripts/put-secret.sh");

// Stand-ins for the 1Password and AWS CLIs: `op` hands back STUB_VALUE, `aws` logs its arguments
// and keeps whatever reaches put-secret-value on stdin.
const OP_STUB = `#!/usr/bin/env bash
[[ -n "\${STUB_OP_FAIL:-}" ]] && exit 1
case "$1" in
  item) printf '{"id":"stubitemid","title":"%s"}' "$3" ;;
  read|document) printf '%s' "$STUB_VALUE" ;;
esac
`;

const AWS_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/aws.log"
if [[ "$2" == "put-secret-value" ]]; then
  cat > "$STUB_DIR/uploaded"
  echo "stub-version"
fi
`;

let stubDir: string;

const run = (args: string[], value: string, extra: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      HOME: stubDir,
      STUB_DIR: stubDir,
      STUB_VALUE: value,
      ...extra,
    },
  });

const awsCalls = () =>
  existsSync(join(stubDir, "aws.log")) ? readFileSync(join(stubDir, "aws.log"), "utf8") : "";

describe("put-secret.sh", () => {
  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "put-secret-"));
    for (const [name, body] of [
      ["op", OP_STUB],
      ["aws", AWS_STUB],
    ] as const) {
      writeFileSync(join(stubDir, name), body);
      chmodSync(join(stubDir, name), 0o755);
    }
  });

  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  it("refuses an API key without the sk-ant- prefix and uploads nothing", () => {
    const result = run(["anthropic-api-key"], "not-an-anthropic-key");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '"Flexi Day Anthropic API key (prod)" does not start with sk-ant-; nothing uploaded'
    );
    expect(result.stderr + result.stdout).not.toContain("not-an-anthropic-key");
    expect(awsCalls()).not.toContain("put-secret-value");
  });

  it("refuses a webhook secret without the whsec_ prefix and uploads nothing", () => {
    const result = run(["anthropic-webhook-secret"], "sk-ant-wrong-item");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not start with whsec_; nothing uploaded");
    expect(awsCalls()).not.toContain("put-secret-value");
  });

  it("refuses an empty read instead of storing an empty secret", () => {
    const failed = run(["anthropic-api-key"], "", { STUB_OP_FAIL: "1" });
    expect(failed.status).toBe(1);
    const empty = run(["anthropic-api-key"], "");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("is empty; nothing uploaded");
    expect(awsCalls()).not.toContain("put-secret-value");
  });

  it("refuses a value with whitespace in it", () => {
    const result = run(["anthropic-api-key"], "sk-ant-test fake");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains whitespace; nothing uploaded");
  });

  it("uploads a value with the right prefix to its slot through stdin", () => {
    const result = run(["anthropic-webhook-secret"], "whsec_dGVzdC1ub3QtYS1zZWNyZXQ=");
    expect(result.status).toBe(0);
    expect(readFileSync(join(stubDir, "uploaded"), "utf8")).toBe("whsec_dGVzdC1ub3QtYS1zZWNyZXQ=");
    expect(awsCalls()).toContain(
      "secretsmanager put-secret-value --secret-id flexi-day-be-production-anthropic-webhook-secret"
    );
    expect(awsCalls()).not.toContain("whsec_");
    expect(result.stdout).not.toContain("whsec_");
  });

  it("answers usage for an unknown kind", () => {
    const result = run(["paddle"], "anything");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "apple|apns|anthropic-api-key|anthropic-webhook-secret [--redeploy]"
    );
  });
});
