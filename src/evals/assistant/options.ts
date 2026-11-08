import type { AssistantEffort } from "../../config.js";
import { resolveExpectation } from "./resolve.js";
import { LANGS, PARTS, type EvalCase, type Lang, type Part } from "./types.js";

export type EvalOptions = {
  parts: Part[] | null;
  langs: Lang[] | null;
  caseIds: string[] | null;
  /** Only the cases marked `smoke`. */
  smoke: boolean;
  /** Overrides `ASSISTANT_MODEL` and `ASSISTANT_EFFORT` for this run. */
  model: string | null;
  effort: AssistantEffort | null;
  /** `snapshot`: the committed KB snapshot; `live`: the production `/help/kb.json`. */
  bundle: "snapshot" | "live";
  writeBaseline: boolean;
  /** Print the selected cases and stop: no key, no database, no spend. */
  list: boolean;
  /** The fake driver and a stub judge: proves the harness with no key; the scores mean nothing. */
  fake: boolean;
};

/** `config.ts`'s efforts, copied: the CLI must not load config, which needs the app's env. */
export const EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AssistantEffort[];

const FLAGS_WITH_VALUES = ["part", "lang", "case", "model", "effort", "bundle"] as const;
const SWITCHES = ["smoke", "write-baseline", "list", "fake"] as const;

const oneOf = <T extends string>(values: readonly T[], value: string, what: string): T => {
  if (!(values as readonly string[]).includes(value)) throw new Error(`Unknown ${what} ${value}`);
  return value as T;
};

const list = (value: string) => value.split(",").filter((item) => item.length > 0);

export const parseEvalArgs = (argv: readonly string[]): EvalOptions => {
  const options: EvalOptions = {
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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s) : [arg];
    if ((SWITCHES as readonly string[]).includes(flag!)) {
      if (flag === "smoke") options.smoke = true;
      if (flag === "write-baseline") options.writeBaseline = true;
      if (flag === "list") options.list = true;
      if (flag === "fake") options.fake = true;
      continue;
    }
    if (!(FLAGS_WITH_VALUES as readonly string[]).includes(flag!)) {
      throw new Error(`Unknown flag ${arg}`);
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${flag} needs a value`);
    switch (flag) {
      case "part":
        options.parts = [
          ...(options.parts ?? []),
          ...list(value).map((p) => oneOf(PARTS, p, "part")),
        ];
        break;
      case "lang":
        options.langs = [
          ...(options.langs ?? []),
          ...list(value).map((l) => oneOf(LANGS, l, "language")),
        ];
        break;
      case "case":
        options.caseIds = [...(options.caseIds ?? []), ...list(value)];
        break;
      case "model":
        options.model = value;
        break;
      case "effort":
        options.effort = oneOf(EFFORTS, value, "effort");
        break;
      case "bundle":
        options.bundle = oneOf(["snapshot", "live"] as const, value, "bundle");
        break;
    }
  }
  if (options.writeBaseline && options.fake) {
    throw new Error("--write-baseline needs real model calls: drop --fake");
  }
  if (
    options.writeBaseline &&
    (options.parts || options.langs || options.caseIds || options.smoke)
  ) {
    throw new Error(
      "--write-baseline needs the full suite: drop --part, --lang, --case and --smoke"
    );
  }
  return options;
};

export const partOf = (evalCase: EvalCase): Part => resolveExpectation(evalCase).part;

/** The cases a run takes, in suite order. */
export const selectCases = (cases: readonly EvalCase[], options: EvalOptions): EvalCase[] => {
  const unknown = (options.caseIds ?? []).filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`No case ${unknown.join(", ")}`);
  return cases.filter(
    (evalCase) =>
      (!options.parts || options.parts.includes(partOf(evalCase))) &&
      (!options.langs || options.langs.includes(evalCase.lang)) &&
      (!options.caseIds || options.caseIds.includes(evalCase.id)) &&
      (!options.smoke || evalCase.smoke === true)
  );
};
