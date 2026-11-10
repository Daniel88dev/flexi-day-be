import { describe, expect, it } from "vitest";
import { ASSISTANT_EFFORTS } from "../../../config.js";
import { EFFORTS, parseEvalArgs, selectCases } from "../options.js";
import type { EvalCase } from "../types.js";

describe("eval:assistant flags", () => {
  it("defaults to the whole suite on the snapshot with the configured model", () => {
    expect(parseEvalArgs([])).toEqual({
      parts: null,
      langs: null,
      caseIds: null,
      smoke: false,
      model: null,
      effort: null,
      bundle: "snapshot",
      writeBaseline: false,
      list: false,
      fake: false,
    });
  });

  it("reads every flag, in both spellings", () => {
    expect(
      parseEvalArgs([
        "--part",
        "tool_args,attacks",
        "--lang=cs",
        "--case",
        "a,b",
        "--case=c",
        "--model",
        "claude-haiku-5-5",
        "--effort=low",
        "--bundle",
        "live",
        "--smoke",
        "--list",
        "--fake",
      ])
    ).toEqual({
      parts: ["tool_args", "attacks"],
      langs: ["cs"],
      caseIds: ["a", "b", "c"],
      smoke: true,
      model: "claude-haiku-5-5",
      effort: "low",
      bundle: "live",
      writeBaseline: false,
      list: true,
      fake: true,
    });
  });

  it("knows the efforts config.ts knows", () => {
    expect([...EFFORTS]).toEqual([...ASSISTANT_EFFORTS]);
  });

  it("refuses unknown flags and values", () => {
    expect(() => parseEvalArgs(["--parts", "x"])).toThrow("Unknown flag --parts");
    expect(() => parseEvalArgs(["--part", "jokes"])).toThrow("Unknown part jokes");
    expect(() => parseEvalArgs(["--lang", "de"])).toThrow("Unknown language de");
    expect(() => parseEvalArgs(["--effort", "turbo"])).toThrow("Unknown effort turbo");
    expect(() => parseEvalArgs(["--bundle", "dev"])).toThrow("Unknown bundle dev");
    expect(() => parseEvalArgs(["--model"])).toThrow("--model needs a value");
  });

  it("writes a baseline only from a full run", () => {
    expect(parseEvalArgs(["--write-baseline", "--effort", "low"]).writeBaseline).toBe(true);
    expect(() => parseEvalArgs(["--write-baseline", "--fake"])).toThrow(
      "--write-baseline needs real model calls"
    );
    expect(() => parseEvalArgs(["--write-baseline", "--case", "a"])).toThrow(
      "--write-baseline needs the full suite"
    );
  });
});

const evalCase = (id: string, over: Partial<EvalCase> = {}): EvalCase => ({
  id,
  lang: "en",
  persona: "member",
  message: "…",
  expect: { part: "attacks" },
  ...over,
});

describe("case selection", () => {
  const cases = [
    evalCase("a"),
    evalCase("b", { lang: "cs", smoke: true }),
    evalCase("c", { expect: { part: "off_topic" }, smoke: true }),
  ];
  const all = parseEvalArgs([]);

  it("takes everything by default", () => {
    expect(selectCases(cases, all).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by part, language, smoke and id", () => {
    expect(selectCases(cases, { ...all, parts: ["attacks"] }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(selectCases(cases, { ...all, langs: ["cs"] }).map((c) => c.id)).toEqual(["b"]);
    expect(selectCases(cases, { ...all, smoke: true }).map((c) => c.id)).toEqual(["b", "c"]);
    expect(selectCases(cases, { ...all, caseIds: ["c", "a"] }).map((c) => c.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("names an id no case has", () => {
    expect(() => selectCases(cases, { ...all, caseIds: ["a", "zz"] })).toThrow("No case zz");
  });
});
