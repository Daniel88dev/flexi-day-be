/**
 * Anthropic list prices for the models the Assistant runs, in integer
 * micro-USD per million tokens. Append-only: a price change is a new row with
 * a later `effectiveFrom`, never an edit, so every ledger row's
 * `price_version` keeps pointing at the rates it was charged at.
 */

type Rates = {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

type Tier = Rates & {
  /** The tier applies to prompts up to this many tokens; `null` for the last tier. */
  upToPromptTokens: number | null;
};

export type PriceRow = {
  model: string;
  effectiveFrom: Date;
  version: string;
  tiers: Tier[];
};

const row = (model: string, effectiveFrom: string, tiers: Tier[]): PriceRow => ({
  model,
  effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
  version: `${model}@${effectiveFrom}`,
  tiers,
});

export const PRICE_TABLE: readonly PriceRow[] = [
  row("claude-sonnet-5-5", "2026-11-01", [
    {
      upToPromptTokens: null,
      input: 2_000_000,
      cacheWrite5m: 2_500_000,
      cacheWrite1h: 4_000_000,
      cacheRead: 100_000,
      output: 10_000_000,
    },
  ]),
  row("claude-haiku-5-5", "2026-11-01", [
    {
      upToPromptTokens: 100_000,
      input: 100_000,
      cacheWrite5m: 125_000,
      cacheWrite1h: 200_000,
      cacheRead: 10_000,
      output: 500_000,
    },
    {
      upToPromptTokens: null,
      input: 500_000,
      cacheWrite5m: 625_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 50_000,
      output: 2_500_000,
    },
  ]),
];

/** Token counts one metered step used, with the cache-write split `session.usage` reports. */
export type MeteredUsage = {
  inputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export const hasPrice = (model: string): boolean => PRICE_TABLE.some((r) => r.model === model);

/** The row in force for `model` at `at`. Throws for a model or a date the table doesn't cover. */
export const priceFor = (model: string, at: Date): PriceRow => {
  const found = PRICE_TABLE.filter((r) => r.model === model && r.effectiveFrom <= at).sort(
    (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()
  )[0];
  if (!found) throw new Error(`No price for model ${model} at ${at.toISOString()}`);
  return found;
};

export const promptTokens = (usage: MeteredUsage): number =>
  usage.inputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens + usage.cacheReadTokens;

const tierFor = (price: PriceRow, prompt: number): Tier =>
  price.tiers.find((tier) => tier.upToPromptTokens === null || prompt <= tier.upToPromptTokens) ??
  price.tiers.at(-1)!;

/** What `usage` costs in micro-USD at `price`, rounded up to a whole micro-USD. */
export const costOf = (price: PriceRow, usage: MeteredUsage): number => {
  const rates = tierFor(price, promptTokens(usage));
  const perMillion =
    usage.inputTokens * rates.input +
    usage.cacheWrite5mTokens * rates.cacheWrite5m +
    usage.cacheWrite1hTokens * rates.cacheWrite1h +
    usage.cacheReadTokens * rates.cacheRead +
    usage.outputTokens * rates.output;
  return Math.ceil(perMillion / 1_000_000);
};

/** One token kind's rate at the tier for a prompt this long. */
export const rateFor = (price: PriceRow, prompt: number, kind: keyof Rates): number =>
  tierFor(price, prompt)[kind];
