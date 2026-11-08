import type { CaseResult, CaseRun, Report } from "../report.js";
import { resolveExpectation } from "../resolve.js";
import type { EvalCase, Judge, JudgeVerdict, PersonaKey, SeedRefs } from "../types.js";
import { SpendLimitError, isSpendRefusal, runCase } from "./runCase.js";

/** Core tool-argument cases run this often and must pass every time. */
export const CORE_RUNS = 3;

const inScopeOf = (evalCase: EvalCase): boolean => {
  const expectation = resolveExpectation(evalCase);
  return (
    ["tool_args", "golden", "injection"].includes(expectation.part) ||
    (expectation.part === "borderline" && expectation.inScope === true)
  );
};

const toResult = (evalCase: EvalCase, runs: CaseRun[]): CaseResult => {
  const expectation = resolveExpectation(evalCase);
  const failed = runs.find((run) => !run.score.pass);
  return {
    id: evalCase.id,
    part: expectation.part,
    lang: evalCase.lang,
    persona: evalCase.persona,
    core: expectation.part === "tool_args" && expectation.core === true,
    inScope: inScopeOf(evalCase),
    pass: runs.length > 0 && !failed,
    failedCheck: failed?.score.failedCheck ?? null,
    falseRefusal: runs.some((run) => run.score.falseRefusal),
    costMicroUsd: runs.reduce((sum, run) => sum + run.costMicroUsd, 0),
    runs,
  };
};

export type SuiteOutcome = {
  results: CaseResult[];
  stopped: Report["stopped"];
  judgeMicroUsd: number;
};

/**
 * Personas run in parallel, each persona's cases one after another. No
 * automatic retries. The first spend-limit refusal stops every persona; the
 * cases already done keep their results.
 */
export const runSuite = async (args: {
  cases: EvalCase[];
  seed: SeedRefs;
  judge: Judge;
  onResult?: (result: CaseResult) => void;
}): Promise<SuiteOutcome> => {
  let stopped: Report["stopped"] = null;
  let judgeMicroUsd = 0;
  const judge: Judge = async (request) => {
    let verdict: JudgeVerdict;
    try {
      verdict = await args.judge(request);
    } catch (error) {
      if (isSpendRefusal(error)) throw new SpendLimitError("judge");
      throw error;
    }
    judgeMicroUsd += verdict.costMicroUsd;
    return verdict;
  };

  const byPersona = new Map<PersonaKey, EvalCase[]>();
  for (const evalCase of args.cases) {
    byPersona.set(evalCase.persona, [...(byPersona.get(evalCase.persona) ?? []), evalCase]);
  }

  const results = new Map<string, CaseResult>();
  await Promise.all(
    [...byPersona.values()].map(async (cases) => {
      for (const evalCase of cases) {
        const expectation = resolveExpectation(evalCase, args.seed);
        const attempts = expectation.part === "tool_args" && expectation.core ? CORE_RUNS : 1;
        const runs: CaseRun[] = [];
        for (let attempt = 0; attempt < attempts && !stopped; attempt++) {
          try {
            runs.push(await runCase({ evalCase, seed: args.seed, judge }));
          } catch (error) {
            stopped =
              error instanceof SpendLimitError
                ? { reason: "spend_limit", atCase: evalCase.id }
                : {
                    reason: "error",
                    atCase: evalCase.id,
                    message: error instanceof Error ? error.name : "unknown",
                  };
          }
        }
        if (runs.length === attempts) {
          const result = toResult(evalCase, runs);
          results.set(evalCase.id, result);
          args.onResult?.(result);
        }
        if (stopped) return;
      }
    })
  );

  return {
    results: args.cases.flatMap((evalCase) => results.get(evalCase.id) ?? []),
    stopped,
    judgeMicroUsd,
  };
};
