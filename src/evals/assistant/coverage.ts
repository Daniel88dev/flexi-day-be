import { resolveExpectation } from "./resolve.js";
import { LANGS, type EvalCase, type ExpectedCall } from "./types.js";

export type CoveredTool = { name: string; kind: "read" | "write"; userText: readonly string[] };

const expectedCalls = (evalCase: EvalCase): ExpectedCall[] => {
  const expectation = resolveExpectation(evalCase);
  if (expectation.part === "tool_args") return expectation.calls;
  if (expectation.part === "borderline") return expectation.calls ?? [];
  return [];
};

/**
 * The growth rule as a list of gaps: every tool has a tool-argument case in
 * each language, every write tool a `core` one, and every tool that returns
 * user-written text an injection case. Empty when the cases cover the registry.
 */
export const coverageGaps = (
  tools: readonly CoveredTool[],
  cases: readonly EvalCase[]
): string[] => {
  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) gaps.push(`case id ${evalCase.id} is used twice`);
    seen.add(evalCase.id);
  }
  if (gaps.length > 0) return gaps;

  const registered = new Set(tools.map((tool) => tool.name));
  for (const evalCase of cases) {
    for (const call of expectedCalls(evalCase)) {
      if (!registered.has(call.tool)) {
        gaps.push(`case ${evalCase.id} expects ${call.tool}, which is not registered`);
      }
    }
  }

  const toolArgCases = cases.flatMap((evalCase) => {
    const expectation = resolveExpectation(evalCase);
    return expectation.part === "tool_args" ? [{ evalCase, expectation }] : [];
  });
  const injectionVia = new Set(
    cases.flatMap((evalCase) => {
      const expectation = resolveExpectation(evalCase);
      return expectation.part === "injection" ? expectation.via : [];
    })
  );

  for (const tool of tools) {
    const covering = toolArgCases.filter(({ expectation }) =>
      expectation.calls.some((call) => call.tool === tool.name)
    );
    for (const lang of LANGS) {
      if (!covering.some(({ evalCase }) => evalCase.lang === lang)) {
        gaps.push(`${tool.name} has no ${lang} tool-argument case`);
      }
    }
    if (tool.kind === "write" && !covering.some(({ expectation }) => expectation.core)) {
      gaps.push(`${tool.name} has no core tool-argument case`);
    }
    if (tool.userText.length > 0 && !injectionVia.has(tool.name)) {
      gaps.push(`${tool.name} has no injection case`);
    }
  }
  return gaps;
};
