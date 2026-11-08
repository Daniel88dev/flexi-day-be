import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { config } from "../../config.js";
import { desiredAgentConfig } from "../../services/assistant/agent/agentSync.js";
import { anthropicClient } from "../../services/assistant/driver/anthropicClient.js";
import { fakeDriver } from "../../services/assistant/driver/fakeDriver.js";
import { createManagedDriver } from "../../services/assistant/driver/managedDriver.js";
import type { AssistantDriver } from "../../services/assistant/driver/types.js";
import { knowledgeBase, resetKnowledgeBase } from "../../services/knowledgeBase/knowledgeBase.js";
import { readKbSnapshot } from "../../tests/fixtures/kbSnapshot.js";
import { listenOnLoopback } from "../../tests/loopbackServer.js";
import { casesFor } from "./cases/index.js";
import { JUDGE_MODEL, createJudge } from "./judge.js";
import { selectCases } from "./options.js";
import { buildReport, renderSummary, type Baseline } from "./report.js";
import { ensureEvalAgent, type EvalAgent } from "./runner/evalAgent.js";
import { evalDriver } from "./runner/evalDriver.js";
import { runSuite } from "./runner/runSuite.js";
import { loadSeed } from "./seed/loadSeed.js";
import { BASELINE_PATH, EVAL_NOW, LIVE_BUNDLE_URL, readRunEnv } from "./runEnv.js";
import type { Judge } from "./types.js";

vi.mock("../../services/assistant/driver/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/assistant/driver/index.js")>();
  const { evalDriver: current } = await import("./runner/evalDriver.js");
  return { ...actual, assistantDriver: () => current.driver ?? actual.assistantDriver() };
});

/** The screen's latency, measured around the driver call. */
const timed = (driver: AssistantDriver, screenMs: number[]): AssistantDriver => ({
  ...driver,
  screen: async (input, signal) => {
    const started = performance.now();
    try {
      return await driver.screen(input, signal);
    } finally {
      screenMs.push(Math.round(performance.now() - started));
    }
  },
});

const bundleText = async (source: "snapshot" | "live"): Promise<string> => {
  if (source === "snapshot") return readKbSnapshot();
  const res = await fetch(LIVE_BUNDLE_URL);
  if (!res.ok) throw new Error(`The live bundle answered ${res.status}`);
  return res.text();
};

/** Serves the bundle to the knowledge-base loader, as the frontend serves `/help/kb.json`. */
const serveBundle = async (body: string) => {
  const server = await listenOnLoopback((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  config.knowledgeBase.bundleUrl = `${server.url}/help/kb.json`;
  resetKnowledgeBase();
  await knowledgeBase().refresh();
  return server;
};

const stubJudge: Judge = () =>
  Promise.resolve({ pass: true, reason: "fake run: no judge", costMicroUsd: 0 });

test("assistant eval", async () => {
  const run = readRunEnv();
  const startedAt = new Date().toISOString();
  vi.useFakeTimers({ now: EVAL_NOW, toFake: ["Date"], shouldAdvanceTime: true });

  config.aiFeatures = { ...config.aiFeatures, assistantEnabled: true };
  // The eval organization is the only one in this process, so this raises its limit alone.
  config.assistant.weeklyLimitMicroUsd = 1_000_000_000;

  const raw = await bundleText(run.options.bundle);
  const bundle = JSON.parse(raw) as { version: string };
  const server = await serveBundle(raw);
  const cases = selectCases(casesFor(bundle), run.options);

  const screenMs: number[] = [];
  let agent: EvalAgent | null = null;
  let judge = stubJudge;
  if (run.options.fake) {
    evalDriver.driver = timed(fakeDriver, screenMs);
  } else {
    const client = anthropicClient();
    agent = await ensureEvalAgent({ client, desired: desiredAgentConfig() });
    evalDriver.driver = timed(
      createManagedDriver({
        client,
        agentId: agent.agentId,
        environmentId: agent.environmentId,
        screenModel: config.assistant.screenModel,
        agentVersion: agent.version,
      }),
      screenMs
    );
    judge = createJudge({ client });
  }

  const seed = await loadSeed();
  const outcome = await runSuite({
    cases,
    seed,
    judge,
    onResult: (result) =>
      process.stderr.write(
        `${result.pass ? "pass" : "FAIL"} ${result.id}${result.failedCheck ? ` (${result.failedCheck})` : ""} $${(result.costMicroUsd / 1e6).toFixed(4)}\n`
      ),
  });
  await server.close();
  vi.useRealTimers();

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const report = buildReport({
    meta: {
      startedAt,
      finishedAt: new Date().toISOString(),
      model: config.assistant.model,
      effort: config.assistant.effort,
      screenModel: config.assistant.screenModel,
      judgeModel: run.options.fake ? "none" : JUDGE_MODEL,
      bundle: { source: run.options.bundle, version: bundle.version },
      agent: agent && { id: agent.agentId, version: agent.version },
    },
    results: outcome.results,
    stopped: outcome.stopped,
    judgeMicroUsd: outcome.judgeMicroUsd,
    screenMs,
    baseline,
  });
  mkdirSync(run.outDir, { recursive: true });
  writeFileSync(join(run.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(run.outDir, "summary.md"), renderSummary(report));
});
