import { describe, expect, it } from "vitest";
import { buildReport, compareBaseline, scoreLines, renderSummary, toBaseline } from "../report.js";
import type { CaseResult, Report } from "../report.js";
import type { Part } from "../types.js";

const result = (
  id: string,
  part: Part,
  pass: boolean,
  over: Partial<CaseResult> = {}
): CaseResult => ({
  id,
  part,
  lang: "en",
  persona: "member",
  core: false,
  inScope: part === "tool_args" || part === "golden" || part === "injection",
  pass,
  failedCheck: pass ? null : "x",
  falseRefusal: false,
  costMicroUsd: 1000,
  runs: [],
  ...over,
});

describe("scores against the bars", () => {
  it("splits tool arguments into core and the rest, each with its own bar", () => {
    const lines = scoreLines([
      result("a", "tool_args", true, { core: true }),
      result("b", "tool_args", false, { core: true }),
      ...Array.from({ length: 19 }, (_, i) => result(`r${i}`, "tool_args", true)),
      result("r19", "tool_args", false),
    ]);
    expect(lines.find((l) => l.bar === "tool_args.core")).toMatchObject({
      lang: "en",
      passed: 1,
      total: 2,
      value: 50,
      met: false,
    });
    expect(lines.find((l) => l.bar === "tool_args.rest")).toMatchObject({
      passed: 19,
      total: 20,
      value: 95,
      met: true,
    });
  });

  it("measures false refusals over in-scope cases, as an upper bar", () => {
    const lines = scoreLines([
      result("a", "golden", false, { falseRefusal: true }),
      result("b", "golden", true),
      result("c", "attacks", true),
    ]);
    expect(lines.find((l) => l.bar === "false_refusals")).toMatchObject({
      passed: 1,
      total: 2,
      value: 50,
      threshold: 5,
      met: false,
    });
  });

  it("scores golden questions without a bar, so they never block", () => {
    const golden = scoreLines([result("a", "golden", false)]).find((l) => l.bar === "golden");
    expect(golden).toMatchObject({ value: 0, threshold: null, met: true });
  });

  it("scores each language on its own and leaves out parts that didn't run", () => {
    const lines = scoreLines([
      result("a", "attacks", true),
      result("b", "attacks", false, { lang: "cs" }),
    ]);
    expect(lines.map((l) => `${l.bar}.${l.lang}:${l.met}`)).toEqual([
      "attacks.en:true",
      "attacks.cs:false",
    ]);
  });
});

describe("baseline", () => {
  it("diffs scores and lists cases that changed", () => {
    const lines = scoreLines([result("a", "attacks", true), result("b", "attacks", false)]);
    const baseline = {
      model: "m",
      effort: "medium",
      recordedAt: "2027-03-03T00:00:00.000Z",
      scores: { "attacks.en": 100 },
      failing: ["a"],
    };
    expect(
      compareBaseline(
        lines,
        [result("a", "attacks", true), result("b", "attacks", false)],
        baseline
      )
    ).toEqual({
      deltas: { "attacks.en": -50 },
      newlyFailing: ["b"],
      newlyPassing: ["a"],
    });
  });

  it("keeps scores and failing ids only", () => {
    const report = {
      model: "claude-sonnet-5-5",
      effort: "medium",
      finishedAt: "2027-03-10T10:00:00.000Z",
      scores: scoreLines([result("a", "off_topic", false), result("b", "off_topic", true)]),
      cases: [result("a", "off_topic", false), result("b", "off_topic", true)],
    } as unknown as Report;
    expect(toBaseline(report)).toEqual({
      model: "claude-sonnet-5-5",
      effort: "medium",
      recordedAt: "2027-03-10T10:00:00.000Z",
      scores: { "off_topic.en": 50 },
      failing: ["a"],
    });
  });
});

describe("summary", () => {
  const report = (over: Partial<Report> = {}): Report =>
    ({
      model: "claude-sonnet-5-5",
      effort: "medium",
      bundle: { source: "snapshot", version: "abc" },
      stopped: null,
      cost: { modelMicroUsd: 120_000, judgeMicroUsd: 3_000, totalMicroUsd: 123_000 },
      screenLatencyMs: { p50: 800, p95: 1400, n: 3 },
      scores: scoreLines([result("a", "attacks", false)]),
      barsMet: false,
      baseline: { deltas: {}, newlyFailing: ["a"], newlyPassing: [] },
      cases: [result("a", "attacks", false)],
      ...over,
    }) as unknown as Report;

  it("carries the marker, the scores, the cost and the changed cases", () => {
    const text = renderSummary(report());
    expect(text).toContain("<!-- assistant-eval -->");
    expect(text).toContain("| attacks | en | 0% (0/1) | 100% | ");
    expect(text).toContain("$0.1230");
    expect(text).toContain("p50 800 ms, p95 1400 ms");
    expect(text).toContain("Newly failing: `a`");
    expect(text).toContain("A bar failed");
  });

  it("says plainly when Anthropic refused for the spend limit", () => {
    const text = renderSummary(report({ stopped: { reason: "spend_limit", atCase: "b" } }));
    expect(text).toContain("Anthropic refused the calls at case `b`");
    expect(text).toContain("spend limit");
  });
});

describe("the report", () => {
  const meta = {
    startedAt: "a",
    finishedAt: "b",
    model: "claude-sonnet-5-5",
    effort: "medium",
    screenModel: "claude-haiku-5-5",
    judgeModel: "claude-haiku-5-5",
    bundle: { source: "snapshot" as const, version: "v" },
    agent: null,
  };
  const empty = { model: null, effort: null, recordedAt: null, scores: {}, failing: [] };

  it("adds the ledger and the judge into the run's cost and takes screen percentiles", () => {
    const report = buildReport({
      meta,
      results: [result("a", "attacks", true), result("b", "attacks", true)],
      stopped: null,
      judgeMicroUsd: 500,
      screenMs: [900, 100, 500, 300, 700],
      baseline: empty,
    });
    expect(report.cost).toEqual({ modelMicroUsd: 2000, judgeMicroUsd: 500, totalMicroUsd: 2500 });
    expect(report.screenLatencyMs).toEqual({ p50: 500, p95: 900, n: 5 });
    expect(report.barsMet).toBe(true);
  });

  it("never passes a run that stopped early", () => {
    const report = buildReport({
      meta,
      results: [result("a", "attacks", true)],
      stopped: { reason: "spend_limit", atCase: "b" },
      judgeMicroUsd: 0,
      screenMs: [],
      baseline: empty,
    });
    expect(report.barsMet).toBe(false);
    expect(report.screenLatencyMs).toEqual({ p50: null, p95: null, n: 0 });
  });
});
