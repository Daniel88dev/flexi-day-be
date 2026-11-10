import { kbSnapshot } from "../../../tests/fixtures/kbSnapshot.js";
import type { EvalCase } from "../types.js";
import { ATTACKS } from "./attacks.js";
import { BORDERLINE } from "./borderline.js";
import { goldenCases, type GoldenQuestion } from "./golden.js";
import { INJECTION } from "./injection.js";
import { OFF_TOPIC } from "./offTopic.js";
import { TOOL_ARGS_CS } from "./toolArgs.cs.js";
import { TOOL_ARGS_EN } from "./toolArgs.en.js";

/** Golden questions of a bundle, `[]` when it carries none. */
export const goldenQuestionsOf = (bundle: unknown): GoldenQuestion[] =>
  (bundle as { goldenQuestions?: GoldenQuestion[] }).goldenQuestions ?? [];

/** Every hand-written case; golden cases come from the bundle the run uses. */
export const WRITTEN_CASES: readonly EvalCase[] = [
  ...TOOL_ARGS_EN,
  ...TOOL_ARGS_CS,
  ...OFF_TOPIC,
  ...BORDERLINE,
  ...ATTACKS,
  ...INJECTION,
] as EvalCase[];

export const casesFor = (bundle: unknown): EvalCase[] => [
  ...WRITTEN_CASES,
  ...goldenCases(goldenQuestionsOf(bundle)),
];

/** The cases against the committed KB snapshot, as PR runs see them. */
export const ALL_CASES: readonly EvalCase[] = casesFor(kbSnapshot());
