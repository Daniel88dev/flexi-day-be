import { describe, expect, it } from "vitest";
import { costOf, hasPrice, priceFor, type MeteredUsage } from "../prices.js";

const usage = (overrides: Partial<MeteredUsage>): MeteredUsage => ({
  inputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  ...overrides,
});

const at = new Date("2026-11-10T12:00:00Z");

describe("the price table", () => {
  it("prices a million tokens of each kind on Sonnet 5.5 at the spec's rates", () => {
    const row = priceFor("claude-sonnet-5-5", at);
    expect(costOf(row, usage({ inputTokens: 1_000_000 }))).toBe(2_000_000);
    expect(costOf(row, usage({ cacheWrite5mTokens: 1_000_000 }))).toBe(2_500_000);
    expect(costOf(row, usage({ cacheWrite1hTokens: 1_000_000 }))).toBe(4_000_000);
    expect(costOf(row, usage({ cacheReadTokens: 1_000_000 }))).toBe(100_000);
    expect(costOf(row, usage({ outputTokens: 1_000_000 }))).toBe(10_000_000);
  });

  it("reproduces the spike's first Sonnet request: 82 in, 7,713 written, 253 out", () => {
    // 82 × 2 + 7,713 × 2.5 + 253 × 10 = 164 + 19,282.5 + 2,530 micro-USD, rounded up.
    const row = priceFor("claude-sonnet-5-5", at);
    expect(
      costOf(row, usage({ inputTokens: 82, cacheWrite5mTokens: 7713, outputTokens: 253 }))
    ).toBe(21_977);
  });

  it("charges Haiku 5.5 its higher rates once a prompt passes 100k tokens", () => {
    const row = priceFor("claude-haiku-5-5", at);
    expect(costOf(row, usage({ inputTokens: 100_000, outputTokens: 1_000 }))).toBe(10_500);
    expect(costOf(row, usage({ inputTokens: 100_001, outputTokens: 1_000 }))).toBe(52_501);
    expect(
      costOf(
        row,
        usage({ cacheReadTokens: 200_000, cacheWrite5mTokens: 1_000, cacheWrite1hTokens: 1_000 })
      )
    ).toBe(10_000 + 625 + 1_000);
  });

  it("names a price version per model and effective date", () => {
    expect(priceFor("claude-sonnet-5-5", at).version).toBe("claude-sonnet-5-5@2026-11-01");
    expect(priceFor("claude-haiku-5-5", at).version).toBe("claude-haiku-5-5@2026-11-01");
  });

  it("knows only the models it has rows for", () => {
    expect(hasPrice("claude-sonnet-5-5")).toBe(true);
    expect(hasPrice("claude-haiku-5-5")).toBe(true);
    expect(hasPrice("claude-opus-5-5")).toBe(false);
    expect(() => priceFor("claude-opus-5-5", at)).toThrow(/no price/i);
  });

  it("has no row before the first effective date", () => {
    expect(() => priceFor("claude-sonnet-5-5", new Date("2026-01-01T00:00:00Z"))).toThrow(
      /no price/i
    );
  });
});
