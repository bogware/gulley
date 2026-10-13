import { describe, expect, it } from 'vitest';
import { computeCost, rankPrice, type RateOverride } from './compute';

const usage = (inputTokens: number) => ({
  inputTokens,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 1_000,
  seen: true,
});

describe('rankPrice', () => {
  it('sums input + output from the resolver, else the seed, else undefined', () => {
    expect(rankPrice('anthropic', 'claude-opus-5')).toBe(30); // seed $5 + $25
    expect(rankPrice('anthropic', 'claude-opus-5', () => ({ input: 1, output: 2 }))).toBe(3);
    expect(rankPrice('anthropic', 'claude-mystery')).toBeUndefined();
    expect(rankPrice('nope', 'x')).toBeUndefined();
  });

  it('ranks a non-finite catalog rate as unpriced instead of NaN/Infinity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(rankPrice('anthropic', 'claude-opus-5', () => ({ input: bad, output: 1 }))).toBe(
        undefined,
      );
      expect(rankPrice('anthropic', 'claude-opus-5', () => ({ input: 1, output: bad }))).toBe(
        undefined,
      );
    }
  });
});

describe('RateOverride.tier', () => {
  it('bills a catalog-supplied tier as-is for a model the seed does not know', () => {
    const rate: RateOverride = {
      input: 1,
      output: 2,
      tier: { aboveInputTokens: 1_000, input: 2, output: 4 },
    };
    const long = computeCost('groq', 'mystery', usage(2_000), () => rate);
    expect(long.priced).toBe(true);
    expect(long.inputUsd).toBeCloseTo(0.004, 9); // 2K × $2/MTok
    expect(long.outputUsd).toBeCloseTo(0.004, 9); // 1K × $4/MTok
    const short = computeCost('groq', 'mystery', usage(500), () => rate);
    expect(short.inputUsd).toBeCloseTo(0.0005, 9);
    expect(short.outputUsd).toBeCloseTo(0.002, 9);
  });

  it('a catalog tier beats the seed-scaled tier for a seeded model', () => {
    // Haiku 5.5 seed: ×5 above 100K. The catalog says $0.40/$2.00 above 100K on a
    // $0.10/$0.50 base — the catalog's own tier governs, not seed × ratio ($0.50).
    const rate: RateOverride = {
      input: 0.1,
      output: 0.5,
      tier: { aboveInputTokens: 100_000, input: 0.4, output: 2 },
    };
    const c = computeCost('anthropic', 'claude-haiku-5-5', usage(150_000), () => rate);
    expect(c.inputUsd).toBeCloseTo(0.06, 9); // 150K × $0.40/MTok
    expect(c.outputUsd).toBeCloseTo(0.002, 9); // 1K × $2.00/MTok
  });

  it('ignores a non-finite override tier and falls back to the seed-scaled tier', () => {
    const rate: RateOverride = {
      input: 0.1,
      output: 0.5,
      tier: { aboveInputTokens: Number.NaN, input: Number.NaN, output: 2 },
    };
    const c = computeCost('anthropic', 'claude-haiku-5-5', usage(150_000), () => rate);
    expect(c.priced).toBe(true);
    expect(Number.isNaN(c.totalUsd)).toBe(false);
    expect(c.inputUsd).toBeCloseTo(0.075, 9); // seed tier ×5 scaled to the $0.10 base
  });
});
