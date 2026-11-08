import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const logs = vi.hoisted(() => [] as { level: string; message: string; meta: unknown }[]);
const metrics = vi.hoisted(() => ({ count: vi.fn(), distribution: vi.fn() }));

vi.mock("@sentry/node", () => ({ metrics }));

vi.mock("../../middleware/logger.js", () => {
  const at = (level: string) => (message: string, meta: unknown) => {
    logs.push({ level, message, meta });
  };
  return { logger: { info: at("info"), warn: at("warn"), error: at("error") } };
});

const { aiSignal, AI_SIGNALS } = await import("../aiSignals.js");

/** The spec's list (T-697, Observability), with the level it names. */
const SPEC = {
  "assistant.cost_usd": "info",
  "assistant.screen_failed": "warn",
  "assistant.session_error": "warn",
  "assistant.webhook_rejected": "warn",
  "assistant.webhook_missed": "warn",
  "mcp.daily_limit_reached": "info",
  "assistant.weekly_limit_reached": "info",
  "assistant.provider_refused": "error",
  "session.budget_reached": "warn",
  "agent.thread_context_compacted": "warn",
} as const;

/** The four the alerts count or sum; the rest alert on the log itself. */
const METRICS = [
  "assistant.cost_usd",
  "assistant.screen_failed",
  "assistant.session_error",
  "assistant.webhook_rejected",
];

const CONTENT = "Jana's note: back on Monday";

describe("AI signals", () => {
  const { count, distribution } = metrics;

  beforeEach(() => {
    logs.length = 0;
    count.mockClear();
    distribution.mockClear();
  });

  it("are exactly the spec's metrics and logs, at the spec's levels", () => {
    expect(
      Object.fromEntries(Object.entries(AI_SIGNALS).map(([name, spec]) => [name, spec.level]))
    ).toEqual(SPEC);
  });

  it.each(Object.keys(SPEC) as (keyof typeof SPEC)[])(
    "%s keeps its allowed attributes and drops anything else",
    (name) => {
      const allowed = Object.fromEntries(
        AI_SIGNALS[name].attributes.map((key: string) => [key, key === "microUsd" ? 1500 : "id-1"])
      );
      aiSignal(name, { ...allowed, text: CONTENT, userEmail: "jana@example.test" } as never);

      expect(logs).toEqual([{ level: SPEC[name], message: name, meta: allowed }]);
      const sent = JSON.stringify([count.mock.calls, distribution.mock.calls]);
      expect(sent).not.toContain(CONTENT);
      expect(sent).not.toContain("jana@example.test");
      if (METRICS.includes(name)) {
        expect(count.mock.calls.length + distribution.mock.calls.length).toBe(1);
      } else {
        expect(count).not.toHaveBeenCalled();
        expect(distribution).not.toHaveBeenCalled();
      }
    }
  );

  it("records Assistant spend as dollars", () => {
    aiSignal("assistant.cost_usd", { organizationId: "org-1", purpose: "main", microUsd: 23_698 });
    expect(distribution).toHaveBeenCalledWith("assistant.cost_usd", 0.023698, {
      unit: "usd",
      attributes: { purpose: "main" },
    });
  });

  it("counts a screen failure by purpose and reason, without the chat id", () => {
    aiSignal("assistant.screen_failed", {
      chatId: "chat-1",
      purpose: "message",
      reason: "timeout",
      error: "AbortError",
    });
    expect(count).toHaveBeenCalledWith("assistant.screen_failed", 1, {
      attributes: { purpose: "message", reason: "timeout" },
    });
  });

  it("is emitted somewhere in the app for every name", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "tests") walk(full);
        } else if (entry.name.endsWith(".ts") && entry.name !== "aiSignals.ts") {
          sources.push(fs.readFileSync(full, "utf8"));
        }
      }
    };
    walk(path.resolve(import.meta.dirname, "../.."));
    const all = sources.join("\n");
    const missing = Object.keys(SPEC).filter(
      (name) => !new RegExp(`aiSignal\\(\\s*"${name.replaceAll(".", "\\.")}"`).test(all)
    );
    expect(missing).toEqual([]);
  });
});
