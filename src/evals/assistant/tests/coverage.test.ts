import { describe, expect, it } from "vitest";
import { TOOLS } from "../../../tools/registry.js";
import { ALL_CASES } from "../cases/index.js";
import { coverageGaps, type CoveredTool } from "../coverage.js";
import type { EvalCase } from "../types.js";

const toolArgs = (id: string, lang: "en" | "cs", tool: string, core = false): EvalCase => ({
  id,
  lang,
  persona: "member",
  message: "…",
  expect: { part: "tool_args", core, calls: [{ tool }] },
});

const injection = (id: string, via: string[]): EvalCase => ({
  id,
  lang: "en",
  persona: "member",
  message: "…",
  expect: { part: "injection", via, canary: "X", planted: [] },
});

describe("eval coverage of the registered tools", () => {
  it("has every case the registry asks for", () => {
    expect(coverageGaps(TOOLS, ALL_CASES)).toEqual([]);
  });

  const read: CoveredTool = { name: "list_things", kind: "read", userText: [] };
  const write: CoveredTool = { name: "do_thing", kind: "write", userText: [] };
  const withText: CoveredTool = { name: "list_notes", kind: "read", userText: ["notes[]"] };

  it("names a tool with no tool-argument case in a language", () => {
    expect(coverageGaps([read], [toolArgs("a", "en", "list_things")])).toEqual([
      "list_things has no cs tool-argument case",
    ]);
    expect(coverageGaps([read], [])).toEqual([
      "list_things has no en tool-argument case",
      "list_things has no cs tool-argument case",
    ]);
  });

  it("names a write tool with no core case", () => {
    const cases = [toolArgs("a", "en", "do_thing"), toolArgs("b", "cs", "do_thing")];
    expect(coverageGaps([write], cases)).toEqual(["do_thing has no core tool-argument case"]);
    expect(coverageGaps([write], [...cases, toolArgs("c", "en", "do_thing", true)])).toEqual([]);
  });

  it("names a tool with user-written fields and no injection case", () => {
    const cases = [toolArgs("a", "en", "list_notes"), toolArgs("b", "cs", "list_notes")];
    expect(coverageGaps([withText], cases)).toEqual(["list_notes has no injection case"]);
    expect(coverageGaps([withText], [...cases, injection("i", ["list_notes"])])).toEqual([]);
  });

  it("names a case that expects a tool the registry doesn't have", () => {
    expect(coverageGaps([], [toolArgs("a", "en", "gone_tool")])).toEqual([
      "case a expects gone_tool, which is not registered",
    ]);
  });

  it("names duplicate case ids", () => {
    const cases = [toolArgs("a", "en", "list_things"), toolArgs("a", "cs", "list_things")];
    expect(coverageGaps([read], cases)).toEqual(["case id a is used twice"]);
  });
});
