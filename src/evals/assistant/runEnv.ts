import { fileURLToPath } from "node:url";
import type { EvalOptions } from "./options.js";

/** Today in every eval run: Wednesday 2027-03-10, 09:00 UTC. */
export const EVAL_NOW = new Date("2027-03-10T09:00:00Z");

export const LIVE_BUNDLE_URL = "https://www.flexi-day.com/help/kb.json";

export const BASELINE_PATH = fileURLToPath(new URL("./baseline.json", import.meta.url));

export type RunEnv = {
  options: EvalOptions;
  outDir: string;
};

/** What `eval:assistant` hands its vitest run through the environment. */
export const runEnvVars = (run: RunEnv): Record<string, string> => ({
  EVAL_RUN: JSON.stringify(run),
});

export const readRunEnv = (): RunEnv => {
  const raw = process.env.EVAL_RUN;
  if (!raw) throw new Error("Run the eval through `pnpm run eval:assistant`");
  return JSON.parse(raw) as RunEnv;
};
